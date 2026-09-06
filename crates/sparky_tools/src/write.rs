use crate::path_guard::{resolve_write_path, validate_created_parent};
use crate::tool::{Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use tokio::fs;

pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }

    fn label(&self) -> &str {
        "Write File"
    }

    fn description(&self) -> &str {
        "Create or overwrite a file with exact content."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to file to create/write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write into the file"
                }
            },
            "required": ["path", "content"]
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
        let rel_path = match args.get("path").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return Ok(ToolExecutionResult::error("Missing 'path' parameter")),
        };

        let content = match args.get("content").and_then(|v| v.as_str()) {
            Some(c) => c,
            None => return Ok(ToolExecutionResult::error("Missing 'content' parameter")),
        };

        let full_path = match resolve_write_path(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        if let Some(parent) = full_path.parent() {
            if !parent.exists() {
                if let Err(e) = fs::create_dir_all(parent).await {
                    return Ok(ToolExecutionResult::error(format!(
                        "Failed to create directory structure for {}: {}",
                        rel_path, e
                    )));
                }
            }
        }

        if let Err(err) = validate_created_parent(cwd, &full_path) {
            return Ok(ToolExecutionResult::error(err.to_string()));
        }

        match fs::write(&full_path, content).await {
            Ok(_) => Ok(ToolExecutionResult::success(format!(
                "Successfully wrote {} bytes to {}",
                content.len(),
                rel_path
            ))),
            Err(e) => Ok(ToolExecutionResult::error(format!(
                "Failed to write file {}: {}",
                rel_path, e
            ))),
        }
    }
}
