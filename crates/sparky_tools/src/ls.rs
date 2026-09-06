use crate::path_guard::{canonicalize_existing, should_skip_directory};
use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use walkdir::WalkDir;

pub struct LsTool;

#[async_trait]
impl Tool for LsTool {
    fn name(&self) -> &str {
        "ls"
    }

    fn label(&self) -> &str {
        "List Directory"
    }

    fn description(&self) -> &str {
        "List files and directories in a given path."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path to list (default: current working directory)"
                },
                "recursive": {
                    "type": "boolean",
                    "description": "Whether to list recursively (default: false)"
                }
            }
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
        let rel_path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let recursive = args
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let canonical = match canonicalize_existing(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        let max_depth = if recursive { usize::MAX } else { 1 };
        let mut output = String::new();
        output.push_str(&format!(
            "Listing: {} (recursive: {})\n\n",
            rel_path, recursive
        ));

        let output = tokio::task::spawn_blocking(move || {
            let walker = WalkDir::new(&canonical)
                .max_depth(max_depth)
                .into_iter()
                .filter_entry(|entry| {
                    !entry.file_type().is_dir() || !should_skip_directory(entry.path())
                });
            let mut output = output;
            let mut count = 0;

            for entry in walker.filter_map(|e| e.ok()) {
                if entry.path() == canonical {
                    continue;
                }
                let name = entry.file_name().to_string_lossy();
                if name.starts_with('.') {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&canonical)
                    .unwrap_or(entry.path());
                let file_type = if entry.file_type().is_dir() {
                    "DIR "
                } else {
                    "FILE"
                };
                let size_str = entry
                    .metadata()
                    .map(|m| format!("{} B", m.len()))
                    .unwrap_or_else(|_| "-".to_string());

                output.push_str(&format!(
                    "[{}] {:<40} {}\n",
                    file_type,
                    relative.display(),
                    size_str
                ));
                count += 1;
                if count >= 1000 || output.len() >= sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES {
                    output.push_str("\n[Listing capped at 1000 entries]");
                    break;
                }
            }
            output
        })
        .await?;

        Ok(ToolExecutionResult::success(truncate_output(
            output,
            sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        )))
    }
}
