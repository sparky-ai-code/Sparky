use crate::path_guard::{canonicalize_existing, should_skip_directory};
use crate::tool::{truncate_output, Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use regex::RegexBuilder;
use serde_json::json;
use std::fs;
use walkdir::WalkDir;

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }

    fn label(&self) -> &str {
        "Grep Search"
    }

    fn description(&self) -> &str {
        "Search for regex pattern across files."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Regex pattern to search for"
                },
                "path": {
                    "type": "string",
                    "description": "Directory or file path to search in (default: .)"
                },
                "case_insensitive": {
                    "type": "boolean",
                    "description": "Case insensitive search (default: false)"
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
        let case_insensitive = args
            .get("case_insensitive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let re = match RegexBuilder::new(pattern_str)
            .case_insensitive(case_insensitive)
            .build()
        {
            Ok(r) => r,
            Err(e) => {
                return Ok(ToolExecutionResult::error(format!(
                    "Invalid regex pattern: {}",
                    e
                )))
            }
        };

        let root = match canonicalize_existing(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        let cwd = cwd.to_string();
        let output = tokio::task::spawn_blocking(move || {
            let mut output = String::new();
            let mut match_count = 0;

            for entry in WalkDir::new(&root)
                .into_iter()
                .filter_entry(|entry| {
                    !entry.file_type().is_dir() || !should_skip_directory(entry.path())
                })
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file() {
                    let path = entry.path();
                    let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    if file_name.starts_with('.') {
                        continue;
                    }

                    if let Ok(content) = fs::read_to_string(path) {
                        let rel = path.strip_prefix(&cwd).unwrap_or(path);
                        for (line_num, line) in content.lines().enumerate() {
                            if re.is_match(line) {
                                output.push_str(&format!(
                                    "{}:{}: {}\n",
                                    rel.display(),
                                    line_num + 1,
                                    line.trim()
                                ));
                                match_count += 1;
                                if match_count >= 500
                                    || output.len()
                                        >= sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES
                                {
                                    output.push_str("\n[Grep capped at 500 matches]");
                                    break;
                                }
                            }
                        }
                    }
                }
                if match_count >= 500
                    || output.len() >= sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES
                {
                    break;
                }
            }
            output
        })
        .await?;

        if output.is_empty() {
            Ok(ToolExecutionResult::success("No matches found."))
        } else {
            Ok(ToolExecutionResult::success(truncate_output(
                output,
                sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
            )))
        }
    }
}
