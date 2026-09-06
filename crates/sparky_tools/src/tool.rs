use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionResult {
    pub output: String,
    pub is_error: bool,
}

impl ToolExecutionResult {
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            is_error: false,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            output: error.into(),
            is_error: true,
        }
    }
}

pub(crate) fn truncate_output(mut output: String, limit: usize) -> String {
    if output.len() <= limit {
        return output;
    }

    let mut boundary = limit.min(output.len());
    while boundary > 0 && !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    output.push_str(&format!("...\n[Output truncated at {} bytes]", limit));
    output
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value;
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_respects_configured_limit_and_utf8_boundaries() {
        let output = truncate_output("éééé".to_string(), 5);
        assert!(output.starts_with("éé"));
        assert!(output.contains("truncated at 5 bytes"));
    }
}
