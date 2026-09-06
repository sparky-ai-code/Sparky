use crate::path_guard::canonicalize_existing;
use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncBufReadExt, BufReader};

pub struct ReadTool {
    output_limit: usize,
}

impl ReadTool {
    pub fn new(output_limit: usize) -> Self {
        Self { output_limit }
    }
}

impl Default for ReadTool {
    fn default() -> Self {
        Self::new(sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES)
    }
}

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }

    fn label(&self) -> &str {
        "Read File"
    }

    fn description(&self) -> &str {
        "Read file content with line numbers, range selection, and truncation."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to file to read"
                },
                "start_line": {
                    "type": "integer",
                    "description": "Optional 1-based start line (inclusive)"
                },
                "end_line": {
                    "type": "integer",
                    "description": "Optional 1-based end line (inclusive)"
                }
            },
            "required": ["path"]
        })
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Parallel
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let rel_path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return Ok(ToolExecutionResult::error("Missing 'path' parameter")),
        };

        let full_path = match canonicalize_existing(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        let file = match File::open(&full_path).await {
            Ok(file) => file,
            Err(e) => {
                return Ok(ToolExecutionResult::error(format!(
                    "Failed to read file {}: {}",
                    rel_path, e
                )))
            }
        };

        let start = args
            .get("start_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(1)
            .max(1);
        let end = args
            .get("end_line")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .filter(|v| *v >= start);

        let mut output = String::new();
        output.push_str(&format!(
            "File: {} (starting at line {}{})\n\n",
            rel_path,
            start,
            end.map(|line| format!(", through line {}", line))
                .unwrap_or_default()
        ));

        let mut lines = BufReader::new(file).lines();
        let mut line_number = 0usize;
        let mut found = false;
        while let Some(line) = lines.next_line().await? {
            line_number += 1;
            if line_number < start {
                continue;
            }
            if end.is_some_and(|end_line| line_number > end_line) {
                break;
            }
            found = true;
            let formatted = format!("{:4}: {}\n", line_number, line);
            if output.len() + formatted.len() > self.output_limit {
                output.push_str(&format!(
                    "\n[Output truncated at {} bytes]\n",
                    self.output_limit
                ));
                break;
            }
            output.push_str(&formatted);
        }

        if !found {
            return Ok(ToolExecutionResult::error(format!(
                "start_line ({}) exceeds total lines available in the file",
                start
            )));
        }

        output = truncate_output(output, self.output_limit);

        Ok(ToolExecutionResult::success(output))
    }
}
