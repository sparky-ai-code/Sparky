// Keep tool results useful without allowing a single command to dominate the
// model context or the durable session log.
pub const DEFAULT_TOOL_OUTPUT_LIMIT_BYTES: usize = 32_768;
pub const DEFAULT_MAX_OUTPUT_TOKENS: u32 = 16_384;
pub const DEFAULT_CONTEXT_WINDOW_TOKENS: usize = 128_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolOutputLimits {
    pub read_bytes: usize,
    pub bash_bytes: usize,
}

impl Default for ToolOutputLimits {
    fn default() -> Self {
        Self {
            read_bytes: DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
            bash_bytes: DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SparkyConfig {
    pub tool_output_limits: ToolOutputLimits,
    pub default_max_output_tokens: u32,
    pub default_context_window_tokens: usize,
}

impl Default for SparkyConfig {
    fn default() -> Self {
        Self {
            tool_output_limits: ToolOutputLimits::default(),
            default_max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
            default_context_window_tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
        }
    }
}

pub fn max_output_tokens_for_model(model: &str) -> u32 {
    let model = model.to_ascii_lowercase();
    if model.contains("gpt-4o") {
        16_384
    } else if model.contains("claude-3-5-sonnet") || model.contains("gemini-1.5") {
        8_192
    } else {
        DEFAULT_MAX_OUTPUT_TOKENS
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_models_get_specific_output_limits() {
        assert_eq!(max_output_tokens_for_model("gpt-4o"), 16_384);
        assert_eq!(
            max_output_tokens_for_model("claude-3-5-sonnet-latest"),
            8_192
        );
        assert_eq!(
            max_output_tokens_for_model("unknown"),
            DEFAULT_MAX_OUTPUT_TOKENS
        );
    }
}
