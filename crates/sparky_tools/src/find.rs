use crate::path_guard::{canonicalize_existing, should_skip_directory};
use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use glob::Pattern;
use serde_json::json;
use walkdir::WalkDir;

pub struct FindTool;

#[async_trait]
impl Tool for FindTool {
    fn name(&self) -> &str {
        "find"
    }

    fn label(&self) -> &str {
        "Find Files"
    }

    fn description(&self) -> &str {
        "Find files matching a glob pattern."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Glob pattern (e.g. '*.rs', 'src/**/*.ts')"
                },
                "path": {
                    "type": "string",
                    "description": "Directory to search in (default: .)"
                }
            },
            "required": ["pattern"]
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
        let pattern_str = match args.get("pattern").and_then(|v| v.as_str()) {
            Some(p) => p,
            None => return Ok(ToolExecutionResult::error("Missing 'pattern' parameter")),
        };

        let rel_path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let root = match canonicalize_existing(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        let pattern = match Pattern::new(pattern_str) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolExecutionResult::error(format!(
                    "Invalid glob pattern: {}",
                    e
                )))
            }
        };

        let cwd = cwd.to_string();
        let output = tokio::task::spawn_blocking(move || {
            let mut output = String::new();
            let mut count = 0;

            for entry in WalkDir::new(&root)
                .into_iter()
                .filter_entry(|entry| {
                    !entry.file_type().is_dir() || !should_skip_directory(entry.path())
                })
                .filter_map(|e| e.ok())
            {
                let rel = entry.path().strip_prefix(&cwd).unwrap_or(entry.path());
                let file_name = entry.file_name().to_string_lossy();

                if pattern.matches(&file_name) || pattern.matches_path(rel) {
                    output.push_str(&format!("{}\n", rel.display()));
                    count += 1;
                    if count >= 1000
                        || output.len() >= sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES
                    {
                        output.push_str("\n[Find capped at 1000 matches]");
                        break;
                    }
                }
            }
            output
        })
        .await?;

        if output.is_empty() {
            Ok(ToolExecutionResult::success("No matching files found."))
        } else {
            Ok(ToolExecutionResult::success(truncate_output(
                output,
                sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
            )))
        }
    }
}
