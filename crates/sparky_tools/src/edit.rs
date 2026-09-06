use crate::path_guard::canonicalize_existing;
use crate::tool::{Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use similar::TextDiff;
use tokio::fs;

pub struct EditTool;

fn string_arg<'a>(
    args: &'a serde_json::Value,
    snake_case: &str,
    camel_case: &str,
) -> Option<&'a str> {
    args.get(snake_case)
        .or_else(|| args.get(camel_case))
        .and_then(|value| value.as_str())
}

fn normalize_line_endings(text: &str, line_ending: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', line_ending)
}

fn preferred_line_ending(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "\r\n"
    } else if content.contains('\r') {
        "\r"
    } else {
        "\n"
    }
}

fn line_ending_for_match(matched_text: &str, content: &str) -> &'static str {
    if matched_text.contains("\r\n") {
        "\r\n"
    } else if matched_text.contains('\r') {
        "\r"
    } else if matched_text.contains('\n') {
        "\n"
    } else {
        preferred_line_ending(content)
    }
}

#[async_trait]
impl Tool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn label(&self) -> &str {
        "Edit File"
    }

    fn description(&self) -> &str {
        "Replace one exact, unique text block in an existing file. Line endings are normalized automatically; use a block copied from a recent read and retry with a more specific block if it is ambiguous."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the existing file, relative to the current working directory"
                },
                "old_text": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Exact existing text copied from a recent read. It must occur exactly once; include nearby context if needed."
                },
                "new_text": {
                    "type": "string",
                    "description": "Complete replacement for old_text. Preserve indentation; an empty string deletes the target."
                }
            },
            "required": ["path", "old_text", "new_text"],
            "additionalProperties": false
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

        let old_text = match string_arg(&args, "old_text", "oldText") {
            Some("") => return Ok(ToolExecutionResult::error(
                "'old_text' must not be empty. Copy a non-empty, unique block from a recent read.",
            )),
            Some(t) => t,
            None => {
                return Ok(ToolExecutionResult::error(
                    "Missing string 'old_text' parameter (camelCase 'oldText' is also accepted)",
                ))
            }
        };

        let new_text =
            match string_arg(&args, "new_text", "newText") {
                Some(t) => t,
                None => return Ok(ToolExecutionResult::error(
                    "Missing string 'new_text' parameter (camelCase 'newText' is also accepted)",
                )),
            };

        let full_path = match canonicalize_existing(cwd, rel_path) {
            Ok(path) => path,
            Err(err) => return Ok(ToolExecutionResult::error(err.to_string())),
        };

        let content = match fs::read_to_string(&full_path).await {
            Ok(c) => c,
            Err(e) => {
                return Ok(ToolExecutionResult::error(format!(
                    "Failed to read file {}: {}",
                    rel_path, e
                )))
            }
        };

        let line_ending = preferred_line_ending(&content);
        let mut candidate_old_texts = Vec::new();
        for candidate in [
            old_text.to_string(),
            normalize_line_endings(old_text, line_ending),
            normalize_line_endings(old_text, "\n"),
            normalize_line_endings(old_text, "\r\n"),
            normalize_line_endings(old_text, "\r"),
        ] {
            if !candidate_old_texts.contains(&candidate) {
                candidate_old_texts.push(candidate);
            }
        }
        let matches: Vec<_> = candidate_old_texts
            .iter()
            .enumerate()
            .flat_map(|(candidate_index, candidate)| {
                content
                    .match_indices(candidate)
                    .map(move |(offset, _)| (candidate_index, offset))
            })
            .collect();
        if matches.is_empty() {
            return Ok(ToolExecutionResult::error(format!(
                "Could not find 'old_text' in {rel_path}. The file may have changed since it was read, or the block may contain different whitespace. Read the current affected lines and retry once with a non-empty block copied exactly from that output; do not repeat the same failed edit."
            )));
        }
        if matches.len() > 1 {
            return Ok(ToolExecutionResult::error(format!(
                "Found multiple occurrences ({}) of 'old_text' in {rel_path}; no changes were made. Read the affected area and retry with enough unchanged surrounding lines to identify exactly one occurrence.",
                matches.len()
            )));
        }

        let matched_old_text = &candidate_old_texts[matches[0].0];
        let replacement_line_ending = line_ending_for_match(matched_old_text, &content);
        let normalized_new_text = normalize_line_endings(new_text, replacement_line_ending);
        let updated = content.replacen(matched_old_text, &normalized_new_text, 1);
        let diff = TextDiff::from_lines(&content, &updated)
            .unified_diff()
            .header(rel_path, rel_path)
            .to_string();
        match fs::write(&full_path, updated).await {
            Ok(_) => Ok(ToolExecutionResult::success(format!(
                "Successfully edited {}\n\n{}",
                rel_path, diff
            ))),
            Err(e) => Ok(ToolExecutionResult::error(format!(
                "Failed to write updated file {}: {}",
                rel_path, e
            ))),
        }
    }
}
