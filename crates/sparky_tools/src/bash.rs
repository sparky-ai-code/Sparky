use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use std::process::Stdio;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

pub struct BashTool {
    output_limit: usize,
}

impl BashTool {
    pub fn new(output_limit: usize) -> Self {
        Self { output_limit }
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
        "Execute shell commands in the terminal (PowerShell/cmd on Windows, sh/bash on Unix)."
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
            Ok(c) => c,
            Err(e) => {
                return Ok(ToolExecutionResult::error(format!(
                    "Failed to spawn command: {}",
                    e
                )))
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

                combined = truncate_output(combined, self.output_limit);

                if output.status.success() {
                    Ok(ToolExecutionResult::success(combined))
                } else {
                    Ok(ToolExecutionResult::error(format!(
                        "Command failed with exit code {:?}:\n{}",
                        output.status.code(),
                        combined
                    )))
                }
            }
            Ok(Err(e)) => Ok(ToolExecutionResult::error(format!(
                "Command execution error: {}",
                e
            ))),
            Err(_) => Ok(ToolExecutionResult::error(format!(
                "Command timed out after {} seconds",
                timeout_secs
            ))),
        }
    }
}
