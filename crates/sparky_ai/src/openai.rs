use crate::formatting::{openai_messages, openai_tools};
use crate::provider::{CompletionOptions, EventStream, LlmProvider};
use crate::retry::send_with_retry;
use crate::stream_parser;
use crate::types::{Message, Role, ToolCall};

use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

pub struct OpenAiProvider {
    api_key: String,
    api_key_env: Option<String>,
    base_url: String,
    provider_name: &'static str,
    provider_label: &'static str,
    client: Client,
}

impl OpenAiProvider {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self::new_with_api_key_env(api_key, base_url, "OPENAI_API_KEY")
    }

    pub fn new_with_api_key_env(
        api_key: impl Into<String>,
        base_url: Option<String>,
        api_key_env: impl Into<String>,
    ) -> Self {
        Self::new_with_api_key_env_and_provider(api_key, base_url, api_key_env, "openai", "OpenAI")
    }

    pub fn new_with_api_key_env_and_provider(
        api_key: impl Into<String>,
        base_url: Option<String>,
        api_key_env: impl Into<String>,
        provider_name: &'static str,
        provider_label: &'static str,
    ) -> Self {
        let base_url = base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        let is_local = base_url.contains("localhost")
            || base_url.contains("127.0.0.1")
            || base_url.contains("[::1]");
        Self {
            api_key: api_key.into().trim().to_string(),
            api_key_env: (!is_local).then(|| api_key_env.into()),
            base_url,
            provider_name,
            provider_label,
            client: Client::new(),
        }
    }

    fn validate_api_key(&self) -> anyhow::Result<()> {
        if self.api_key.trim().is_empty() {
            if let Some(api_key_env) = &self.api_key_env {
                anyhow::bail!(
                    "ERROR: {} environment variable is not set. Set it before running sparky.",
                    api_key_env
                );
            }
        }
        Ok(())
    }

    /// `prompt_cache_key` is an OpenAI-specific request field. Keep it off
    /// custom/OpenAI-compatible endpoints because some of them reject unknown
    /// fields even though they otherwise implement Chat Completions.
    fn supports_prompt_cache_key(&self) -> bool {
        self.provider_name == "openai"
            && self.base_url.trim_end_matches('/') == "https://api.openai.com/v1"
    }

    /// Derive stable cache affinity from the oldest persisted conversation
    /// message. The agent recreates the leading system message for every model
    /// round, so its timestamp cannot be used. Session messages, however, keep
    /// their timestamp across tool rounds, later user turns, and process
    /// restarts. If compaction removes that message the key changes together
    /// with the model-visible prefix, which is the desired cache boundary.
    fn prompt_cache_key(messages: &[Message]) -> Option<String> {
        messages
            .iter()
            .find(|message| !matches!(&message.role, Role::System))
            .and_then(|message| message.timestamp)
            .map(|timestamp| format!("sparky-{timestamp}"))
    }

    fn apply_prompt_cache_key(&self, body: &mut Value, messages: &[Message]) {
        if !self.supports_prompt_cache_key() {
            return;
        }
        if let Some(cache_key) = Self::prompt_cache_key(messages) {
            body["prompt_cache_key"] = json!(cache_key);
        }
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    fn provider_name(&self) -> &str {
        self.provider_name
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        self.validate_api_key()?;
        let formatted = openai_messages(messages);
        let mut body = json!({
            "model": options.model,
            "messages": formatted,
        });

        if let Some(temp) = options.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max) = options.max_tokens {
            body["max_tokens"] = json!(max);
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            body["reasoning_effort"] = json!(effort);
        }

        if !options.tools.is_empty() {
            body["tools"] = json!(openai_tools(&options.tools));
        }
        self.apply_prompt_cache_key(&mut body, messages);

        let resp = send_with_retry(self.provider_name, || async {
            let mut req = self
                .client
                .post(format!("{}/chat/completions", self.base_url))
                .json(&body);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }
            req.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that the API key is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!(
                "{} API error (HTTP {}): {}{}",
                self.provider_label,
                status,
                err_text,
                hint
            );
        }

        let val: Value = resp.json().await?;
        let choice = &val["choices"][0]["message"];
        let content_str = choice["content"].as_str().unwrap_or("").to_string();

        let tool_calls = choice["tool_calls"].as_array().map(|arr| {
            arr.iter()
                .map(|tc| {
                    let id = tc["id"].as_str().unwrap_or("").to_string();
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                    ToolCall {
                        id,
                        name,
                        arguments: args,
                    }
                })
                .collect()
        });

        let mut msg = Message::assistant(content_str, tool_calls);
        msg.provider = Some(self.provider_name.to_string());
        msg.model = Some(options.model.clone());
        Ok(msg)
    }

    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        self.validate_api_key()?;
        let formatted = openai_messages(messages);
        let mut body = json!({
            "model": options.model,
            "messages": formatted,
            "stream": true,
            "stream_options": { "include_usage": true }
        });

        if let Some(temp) = options.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(max) = options.max_tokens {
            body["max_tokens"] = json!(max);
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            body["reasoning_effort"] = json!(effort);
        }

        if !options.tools.is_empty() {
            body["tools"] = json!(openai_tools(&options.tools));
        }
        self.apply_prompt_cache_key(&mut body, messages);

        let resp = send_with_retry(self.provider_name, || async {
            let mut req = self
                .client
                .post(format!("{}/chat/completions", self.base_url))
                .json(&body);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }
            req.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that the API key is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!(
                "{} API error (HTTP {}): {}{}",
                self.provider_label,
                status,
                err_text,
                hint
            );
        }

        Ok(stream_parser::openai(resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_test_messages() -> Vec<Message> {
        let mut first_user = Message::user("first turn");
        first_user.timestamp = Some(1_725_000_000_123);
        vec![Message::system("system"), first_user]
    }

    #[test]
    fn cache_key_stays_stable_as_the_conversation_grows() {
        let mut messages = cache_test_messages();
        let expected = OpenAiProvider::prompt_cache_key(&messages);
        messages.push(Message::assistant("tool work", None));
        messages.push(Message::user("follow up"));

        assert_eq!(expected.as_deref(), Some("sparky-1725000000123"));
        assert_eq!(OpenAiProvider::prompt_cache_key(&messages), expected);
    }

    #[test]
    fn official_openai_requests_get_cache_affinity() {
        let provider = OpenAiProvider::new("test-key", None);
        let mut body = json!({ "model": "gpt-5.6-sol" });
        provider.apply_prompt_cache_key(&mut body, &cache_test_messages());

        assert_eq!(body["prompt_cache_key"], "sparky-1725000000123");
    }

    #[test]
    fn custom_compatible_endpoints_do_not_receive_openai_only_cache_fields() {
        let provider = OpenAiProvider::new("test-key", Some("http://localhost:1234/v1".into()));
        let mut body = json!({ "model": "local-model" });
        provider.apply_prompt_cache_key(&mut body, &cache_test_messages());

        assert!(body.get("prompt_cache_key").is_none());
    }
}
