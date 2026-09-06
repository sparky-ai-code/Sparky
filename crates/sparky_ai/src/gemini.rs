use crate::formatting::{gemini_messages, gemini_tools};
use crate::provider::{CompletionOptions, EventStream, LlmProvider};
use crate::retry::send_with_retry;
use crate::stream_parser;
use crate::types::{Message, ToolCall};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

pub struct GeminiProvider {
    api_key: String,
    client: Client,
}

impl GeminiProvider {
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            client: Client::new(),
        }
    }

    fn validate_api_key(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.api_key.trim().is_empty(),
            "ERROR: GEMINI_API_KEY environment variable is not set. Set it before running sparky."
        );
        Ok(())
    }

    fn generation_config(options: &CompletionOptions) -> Value {
        let mut config = json!({});
        if let Some(max_tokens) = options.max_tokens {
            config["maxOutputTokens"] = json!(max_tokens);
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            config["thinkingConfig"] = json!({
                "thinkingLevel": effort.to_ascii_uppercase(),
            });
        }
        config
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    fn provider_name(&self) -> &str {
        "gemini"
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        self.validate_api_key()?;
        let (system_instruction, contents) = gemini_messages(messages);

        let mut body = json!({
            "contents": contents,
        });

        if let Some(sys) = system_instruction {
            body["systemInstruction"] = sys;
        }
        if !options.tools.is_empty() {
            body["tools"] = gemini_tools(&options.tools);
        }
        let generation_config = Self::generation_config(options);
        if generation_config
            .as_object()
            .is_some_and(|config| !config.is_empty())
        {
            body["generationConfig"] = generation_config;
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            options.model, self.api_key
        );

        let resp = send_with_retry("gemini", || async {
            self.client.post(&url).json(&body).send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that GEMINI_API_KEY is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!("Gemini API error (HTTP {}): {}{}", status, err, hint);
        }

        let val: Value = resp.json().await?;
        let candidates = val["candidates"].as_array();
        let mut text_buf = String::new();
        let mut tool_calls = Vec::new();

        if let Some(cands) = candidates {
            if let Some(parts) = cands[0]["content"]["parts"].as_array() {
                for part in parts {
                    if let Some(t) = part["text"].as_str() {
                        text_buf.push_str(t);
                    } else if let Some(fc) = part["functionCall"].as_object() {
                        let name = fc
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let args = fc.get("args").cloned().unwrap_or(json!({}));
                        tool_calls.push(ToolCall {
                            id: name.clone(),
                            name,
                            arguments: args,
                        });
                    }
                }
            }
        }

        let mut msg = Message::assistant(
            text_buf,
            if tool_calls.is_empty() {
                None
            } else {
                Some(tool_calls)
            },
        );
        msg.provider = Some("gemini".to_string());
        msg.model = Some(options.model.clone());
        Ok(msg)
    }

    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        self.validate_api_key()?;
        let (system_instruction, contents) = gemini_messages(messages);

        let mut body = json!({ "contents": contents });
        if let Some(system) = system_instruction {
            body["systemInstruction"] = system;
        }
        if !options.tools.is_empty() {
            body["tools"] = gemini_tools(&options.tools);
        }
        let generation_config = Self::generation_config(options);
        if generation_config
            .as_object()
            .is_some_and(|config| !config.is_empty())
        {
            body["generationConfig"] = generation_config;
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse&key={}",
            options.model, self.api_key
        );
        let resp = send_with_retry("gemini", || async {
            self.client.post(&url).json(&body).send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that GEMINI_API_KEY is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!("Gemini API error (HTTP {}): {}{}", status, err, hint);
        }

        Ok(stream_parser::gemini(resp))
    }
}
