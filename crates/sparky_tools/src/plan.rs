use crate::tool::{Tool, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;

pub const END_TASK_TOOL_NAME: &str = "end_task";

/// Control-only tool used to close a completed agent turn. The agent must
/// provide the user-facing summary before calling it; the desktop adapter
/// intentionally suppresses this tool's lifecycle events.
pub struct EndTaskTool;

#[async_trait]
impl Tool for EndTaskTool {
    fn name(&self) -> &str {
        END_TASK_TOOL_NAME
    }

    fn label(&self) -> &str {
        "End task"
    }

    fn description(&self) -> &str {
        "Signal that the task is complete after giving the user a concise summary. Call this last; do not call it while work, verification, approval, or user input remains."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "The same concise final summary already shown to the user immediately before this call"
                }
            },
            "required": ["summary"]
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let summary = args
            .get("summary")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if summary.is_none() {
            return Ok(ToolExecutionResult::error(
                "Missing a concise final 'summary'. Explain what you completed before ending the task.",
            ));
        }

        Ok(ToolExecutionResult::success(
            "Task completion acknowledged.",
        ))
    }
}

pub struct AskUserTool;

#[async_trait]
impl Tool for AskUserTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    fn label(&self) -> &str {
        "Ask User"
    }

    fn description(&self) -> &str {
        "Record a focused question when an implementation decision is required before planning can continue."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "The concise decision question for the user"
                },
                "options": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional mutually exclusive choices"
                }
            },
            "required": ["question"]
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let question = args
            .get("question")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(question) = question else {
            return Ok(ToolExecutionResult::error("Missing 'question' parameter"));
        };

        let options = args
            .get("options")
            .and_then(|value| value.as_array())
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::trim))
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut output = format!("Question for the user: {question}");
        if !options.is_empty() {
            output.push_str("\nOptions:");
            for (index, option) in options.iter().enumerate() {
                output.push_str(&format!("\n{}. {}", index + 1, option));
            }
        }
        output.push_str(
            "\nNo file or external state was changed. Continue with the safest explicit assumption unless the user supplies an answer.",
        );
        Ok(ToolExecutionResult::success(output))
    }
}

pub struct UpdatePlanTool;

#[async_trait]
impl Tool for UpdatePlanTool {
    fn name(&self) -> &str {
        "update_plan"
    }

    fn label(&self) -> &str {
        "Update Plan"
    }

    fn description(&self) -> &str {
        "Maintain the current read-only implementation plan and its rationale."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Ordered implementation or verification steps"
                },
                "explanation": {
                    "type": "string",
                    "description": "Why the plan changed or what remains uncertain"
                }
            },
            "required": ["steps"]
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let Some(steps) = args.get("steps").and_then(|value| value.as_array()) else {
            return Ok(ToolExecutionResult::error("Missing 'steps' array"));
        };
        let steps = steps
            .iter()
            .filter_map(|value| value.as_str().map(str::trim))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if steps.is_empty() {
            return Ok(ToolExecutionResult::error(
                "The 'steps' array must contain at least one non-empty step",
            ));
        }

        let mut output = String::from("Plan updated:\n");
        for (index, step) in steps.iter().enumerate() {
            output.push_str(&format!("{}. {}\n", index + 1, step));
        }
        if let Some(explanation) = args
            .get("explanation")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            output.push_str(&format!("Rationale: {explanation}\n"));
        }
        output.push_str(
            "Read-only planning is still in progress; no files or external state were changed.",
        );
        Ok(ToolExecutionResult::success(output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Tool;

    #[tokio::test]
    async fn end_task_requires_a_user_facing_summary() {
        let missing = EndTaskTool.execute(json!({}), ".").await.unwrap();
        assert!(missing.is_error);

        let result = EndTaskTool
            .execute(
                json!({ "summary": "Implemented and verified the fix." }),
                ".",
            )
            .await
            .unwrap();
        assert!(!result.is_error);
    }

    #[tokio::test]
    async fn ask_user_returns_a_non_mutating_question() {
        let result = AskUserTool
            .execute(
                json!({ "question": "Which database?", "options": ["Postgres", "SQLite"] }),
                ".",
            )
            .await
            .unwrap();
        assert!(!result.is_error);
        assert!(result.output.contains("Which database?"));
        assert!(result
            .output
            .contains("No file or external state was changed"));
    }

    #[tokio::test]
    async fn update_plan_requires_non_empty_steps() {
        let result = UpdatePlanTool
            .execute(json!({ "steps": [] }), ".")
            .await
            .unwrap();
        assert!(result.is_error);
    }
}
