use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, Duration};

const COMMAND_START_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
struct CommandMonitorState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    result: Option<ToolExecutionResult>,
}

impl CommandMonitorState {
    fn output(&self) -> String {
        let stdout = String::from_utf8_lossy(&self.stdout);
        let stderr = String::from_utf8_lossy(&self.stderr);
        if stderr.is_empty() {
            stdout.into_owned()
        } else if stdout.is_empty() {
            stderr.into_owned()
        } else {
            format!("{stdout}\n--- STDERR ---\n{stderr}")
        }
    }
}

#[derive(Clone)]
pub struct CommandMonitor {
    jobs: Arc<Mutex<HashMap<String, watch::Receiver<CommandMonitorState>>>>,
    next_id: Arc<AtomicU64>,
    output_limit: usize,
}

impl CommandMonitor {
    pub fn new(output_limit: usize) -> Self {
        Self {
            jobs: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            output_limit,
        }
    }

    async fn start(&self, command: &str, cwd: &str, timeout_secs: u64) -> ToolExecutionResult {
        let id = format!("cmd-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (sender, receiver) = watch::channel(CommandMonitorState::default());
        self.jobs.lock().await.insert(id.clone(), receiver.clone());
        let output_limit = self.output_limit;
        let command = command.to_string();
        let cwd = cwd.to_string();
        tokio::spawn(async move {
            let result = run_command(
                &command,
                &cwd,
                timeout_secs,
                output_limit,
                sender.clone(),
            )
            .await;
            let mut state = sender.borrow().clone();
            state.result = Some(result);
            sender.send_replace(state);
        });
        let mut receiver = receiver;
        let completed = timeout(COMMAND_START_WAIT, async {
            loop {
                let result = { receiver.borrow().result.clone() };
                if let Some(result) = result {
                    return Some(result);
                }
                if receiver.changed().await.is_err() {
                    return None;
                }
            }
        })
        .await
        .ok()
        .flatten();
        if let Some(result) = completed {
            self.jobs.lock().await.remove(&id);
            return result;
        }

        let current = receiver.borrow().clone();
        let output = truncate_output(current.output(), self.output_limit);
        let output = if output.is_empty() {
            format!("Command is still running.\ncommand_id: {id}")
        } else {
            format!("Command is still running.\ncommand_id: {id}\nCurrent output:\n{output}")
        };
        ToolExecutionResult::success(output).background_started(id)
    }

    async fn status(&self, id: &str) -> ToolExecutionResult {
        let mut jobs = self.jobs.lock().await;
        let Some(receiver) = jobs.get(id) else {
            return ToolExecutionResult::error(format!(
                "Unknown or already completed command_id: {id}"
            ));
        };
        let current = receiver.borrow().clone();
        if let Some(result) = current.result {
            jobs.remove(id);
            return result.background_completed(id.to_owned());
        }

        let output = truncate_output(current.output(), self.output_limit);
        let message = if output.is_empty() {
            format!("Command {id} is still running; no output has been produced yet.")
        } else {
            format!("Command {id} is still running. Current output:\n{output}")
        };
        ToolExecutionResult::success(message)
    }
}

pub struct BashTool {
    monitor: CommandMonitor,
}

impl BashTool {
    pub fn new(output_limit: usize) -> Self {
        Self {
            monitor: CommandMonitor::new(output_limit),
        }
    }

    pub fn monitor(&self) -> CommandMonitor {
        self.monitor.clone()
    }
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new(sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES)
    }
}

#[async_trait]
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn label(&self) -> &str {
        "Bash Terminal"
    }

    fn description(&self) -> &str {
        "Run shell commands. Commands taking longer than five seconds continue in the background with their output available through bash_monitor and the returned command_id."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Command line to execute"
                },
                "timeout_seconds": {
                    "type": "number",
                    "description": "Optional timeout in seconds (default: 300)"
                }
            },
            "required": ["command"]
        })
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let command_str = match args.get("command").and_then(|v| v.as_str()) {
            Some(cmd) => cmd,
            None => return Ok(ToolExecutionResult::error("Missing 'command' parameter")),
        };

        let timeout_secs = args
            .get("timeout_seconds")
            .and_then(|v| v.as_u64())
            .unwrap_or(300);

        Ok(self.monitor.start(command_str, cwd, timeout_secs).await)
    }
}

pub struct BashMonitorTool {
    monitor: CommandMonitor,
}

impl BashMonitorTool {
    pub fn new(monitor: CommandMonitor) -> Self {
        Self { monitor }
    }
}

#[async_trait]
impl Tool for BashMonitorTool {
    fn name(&self) -> &str {
        "bash_monitor"
    }

    fn label(&self) -> &str {
        "Monitor Command"
    }

    fn description(&self) -> &str {
        "Check whether a background bash command is still running and return its latest stdout/stderr output; completed commands include their final result."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command_id": { "type": "string", "description": "ID returned by bash for a running command" }
            },
            "required": ["command_id"]
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let id = match args.get("command_id").and_then(|value| value.as_str()) {
            Some(id) => id,
            None => return Ok(ToolExecutionResult::error("Missing 'command_id' parameter")),
        };
        Ok(self.monitor.status(id).await)
    }
}

async fn run_command(
    command_str: &str,
    cwd: &str,
    timeout_secs: u64,
    output_limit: usize,
    updates: watch::Sender<CommandMonitorState>,
) -> ToolExecutionResult {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args(["-NoProfile", "-Command", command_str]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", command_str]);
        c
    };

    cmd.current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ToolExecutionResult::error(format!("Failed to spawn command: {error}"))
        }
    };
    let Some(mut stdout) = child.stdout.take() else {
        return ToolExecutionResult::error("Failed to capture command stdout");
    };
    let Some(mut stderr) = child.stderr.take() else {
        return ToolExecutionResult::error("Failed to capture command stderr");
    };

    let mut wait = Box::pin(child.wait());
    let mut stdout_closed = false;
    let mut stderr_closed = false;
    let mut exit_status = None;
    let mut state = CommandMonitorState::default();
    let collect_output = async {
        let mut stdout_buffer = [0; 4096];
        let mut stderr_buffer = [0; 4096];
        while !stdout_closed || !stderr_closed || exit_status.is_none() {
            tokio::select! {
                status = &mut wait, if exit_status.is_none() => {
                    exit_status = Some(status.map_err(|error| {
                        format!("Command execution error: {error}")
                    })?);
                }
                read = stdout.read(&mut stdout_buffer), if !stdout_closed => {
                    match read {
                        Ok(0) => stdout_closed = true,
                        Ok(size) => {
                            let available = output_limit.saturating_sub(state.stdout.len() + state.stderr.len());
                            state.stdout.extend_from_slice(&stdout_buffer[..size.min(available)]);
                            updates.send_replace(state.clone());
                        }
                        Err(error) => return Err(format!("Failed to read command stdout: {error}")),
                    }
                }
                read = stderr.read(&mut stderr_buffer), if !stderr_closed => {
                    match read {
                        Ok(0) => stderr_closed = true,
                        Ok(size) => {
                            let available = output_limit.saturating_sub(state.stdout.len() + state.stderr.len());
                            state.stderr.extend_from_slice(&stderr_buffer[..size.min(available)]);
                            updates.send_replace(state.clone());
                        }
                        Err(error) => return Err(format!("Failed to read command stderr: {error}")),
                    }
                }
            }
        }
        Ok::<_, String>(exit_status.expect("child exit status was observed"))
    };

    match timeout(Duration::from_secs(timeout_secs), collect_output).await {
        Ok(Ok(status)) => {
            let output = truncate_output(state.output(), output_limit);
            if status.success() {
                ToolExecutionResult::success(output)
            } else {
                ToolExecutionResult::error(format!(
                    "Command failed with exit code {:?}:\n{}",
                    status.code(),
                    output
                ))
            }
        }
        Ok(Err(error)) => ToolExecutionResult::error(error),
        Err(_) => ToolExecutionResult::error(format!("Command timed out after {timeout_secs} seconds")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn long_commands_return_a_monitor_id_and_can_be_collected() {
        let monitor = CommandMonitor::new(1024);
        let command = if cfg!(windows) {
            "Write-Output started; Start-Sleep -Seconds 6; Write-Output finished"
        } else {
            "printf started; sleep 6; printf finished"
        };

        let started = tokio::time::Instant::now();
        let result = monitor.start(command, ".", 30).await;
        assert!(!result.is_error);
        let id = result
            .output
            .lines()
            .find_map(|line| line.strip_prefix("command_id: "))
            .unwrap()
            .to_string();
        assert!(started.elapsed() >= COMMAND_START_WAIT);
        assert!(result.output.contains("started"));
        assert!(!result.output.contains("finished"));

        let running = monitor.status(&id).await;
        assert!(!running.is_error);
        assert!(running.output.contains("started"));
        assert!(!running.output.contains("finished"));

        tokio::time::sleep(Duration::from_secs(2)).await;
        let completed = monitor.status(&id).await;
        assert!(!completed.is_error);
        assert!(completed.output.contains("finished"));
    }
}
