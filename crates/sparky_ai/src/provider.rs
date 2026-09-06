use crate::types::{AssistantMessageEvent, Message, ThinkingLevel, ToolParamSchema};
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

pub type EventStream = Pin<Box<dyn Stream<Item = AssistantMessageEvent> + Send>>;

#[derive(Debug, Clone)]
pub struct CompletionOptions {
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
    pub thinking_level: ThinkingLevel,
    pub tools: Vec<ToolParamSchema>,
}

impl Default for CompletionOptions {
    fn default() -> Self {
        Self {
            model: "default".to_string(),
            temperature: Some(0.7),
            max_tokens: Some(sparky_config::DEFAULT_MAX_OUTPUT_TOKENS),
            reasoning_effort: None,
            thinking_level: ThinkingLevel::Off,
            tools: Vec::new(),
        }
    }
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn provider_name(&self) -> &str;
    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message>;
    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream>;
}
