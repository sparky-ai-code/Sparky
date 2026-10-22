use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc,
};
use tokio::process::Command;
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, Duration};

const COMMAND_START_WAIT: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct CommandMonitor {
    jobs: Arc<Mutex<HashMap<String, watch::Receiver<Option<ToolExecutionResult>>>>>,
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
        let (sender, receiver) = watch::channel(None);
        self.jobs.lock().await.insert(id.clone(), receiver.clone());
        let output_limit = self.output_limit;
        let command = command.to_string();
        let cwd = cwd.to_string();
        tokio::spawn(async move {
            let result = run_command(&command, &cwd, timeout_secs, output_limit).await;
            sender.send_replace(Some(result));
        });
        let mut receiver = receiver;
        if timeout(COMMAND_START_WAIT, receiver.changed())
            .await
            .is_ok()
        {
            if let Some(result) = receiver.borrow().clone() {
                self.jobs.lock().await.remove(&id);
                return result;
            }
        }
        ToolExecutionResult::success(format!(
            "Command is still running. Monitor it with bash_monitor using command_id: {id}"
        ))
        .background_started(id)
    }

    async fn status(&self, id: &str) -> ToolExecutionResult {
        let mut jobs = self.jobs.lock().await;
        let Some(receiver) = jobs.get(id) else {
            return ToolExecutionResult::error(format!(
                "Unknown or already completed command_id: {id}"
            ));
        };
        let result = receiver.borrow().clone();
        match result {
            Some(result) => {
                jobs.remove(id);
                result.background_completed(id.to_owned())
            }
            None => ToolExecutionResult::success(format!("Command {id} is still running.")),
        }
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
        "Run shell commands. Commands taking longer than five seconds continue in the background; use bash_monitor with the returned command_id to check completion."
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
        "Check whether a background bash command is still running and retrieve its output when it completes."
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

    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return ToolExecutionResult::error(format!("Failed to spawn command: {error}"))
        }
    };

    match timeout(Duration::from_secs(timeout_secs), child.wait_with_output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let mut combined = String::new();
            if !stdout.is_empty() {
                combined.push_str(&stdout);
            }
            if !stderr.is_empty() {
                if !combined.is_empty() {
                    combined.push_str("\n--- STDERR ---\n");
                }
                combined.push_str(&stderr);
            }
            let combined = truncate_output(combined, output_limit);
            if output.status.success() {
                ToolExecutionResult::success(combined)
            } else {
                ToolExecutionResult::error(format!(
                    "Command failed with exit code {:?}:\n{}",
                    output.status.code(),
                    combined
                ))
            }
        }
        Ok(Err(error)) => ToolExecutionResult::error(format!("Command execution error: {error}")),
        Err(_) => {
            ToolExecutionResult::error(format!("Command timed out after {timeout_secs} seconds"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn long_commands_return_a_monitor_id_and_can_be_collected() {
        let monitor = CommandMonitor::new(1024);
        let command = if cfg!(windows) {
            "Start-Sleep -Seconds 6; Write-Output finished"
        } else {
            "sleep 6; printf finished"
        };

        let started = tokio::time::Instant::now();
        let result = monitor.start(command, ".", 30).await;
        assert!(!result.is_error);
        let id = result.output.split("command_id: ").nth(1).unwrap();
        assert!(started.elapsed() >= COMMAND_START_WAIT);
        assert!(monitor.status(id).await.output.contains("still running"));

        tokio::time::sleep(Duration::from_secs(2)).await;
        let completed = monitor.status(id).await;
        assert!(!completed.is_error);
        assert!(completed.output.contains("finished"));
    }
}
