use crate::formatting::{anthropic_messages, anthropic_tools};
use crate::provider::{CompletionOptions, EventStream, LlmProvider};
use crate::retry::send_with_retry;
use crate::stream_parser;
use crate::types::{Message, ToolCall};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{json, Value};

pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    client: Client,
}

impl AnthropicProvider {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| "https://api.anthropic.com/v1".to_string()),
            client: Client::new(),
        }
    }

    fn validate_api_key(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            !self.api_key.trim().is_empty(),
            "ERROR: ANTHROPIC_API_KEY environment variable is not set. Set it before running sparky."
        );
        Ok(())
    }

    fn supports_request_gzip(&self) -> bool {
        self.base_url.trim_end_matches('/') == "https://api.anthropic.com/v1"
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn provider_name(&self) -> &str {
        "anthropic"
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        self.validate_api_key()?;
        let (system_prompt, formatted_msgs) = anthropic_messages(messages);

        let mut body = json!({
            "model": options.model,
            "max_tokens": options.max_tokens.unwrap_or(sparky_config::DEFAULT_MAX_OUTPUT_TOKENS),
            "messages": formatted_msgs
        });

        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }

        if !options.tools.is_empty() {
            body["tools"] = json!(anthropic_tools(&options.tools));
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            body["output_config"] = json!({ "effort": effort });
        }

        let encoded = crate::request_body::encode_json(&body, self.supports_request_gzip())?;
        let resp = send_with_retry("anthropic", || async {
            let mut request = self
                .client
                .post(format!("{}/messages", self.base_url))
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(encoded.bytes.clone());
            if encoded.compressed {
                request = request.header(reqwest::header::CONTENT_ENCODING, "gzip");
            }
            request.send().await
        })
        .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let err = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that ANTHROPIC_API_KEY is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!("Anthropic API error (HTTP {}): {}{}", status, err, hint);
        }

        let val: Value = resp.json().await?;
        let content_arr = val["content"].as_array();

        let mut text_buf = String::new();
        let mut tool_calls = Vec::new();

        if let Some(arr) = content_arr {
            for item in arr {
                if item["type"] == "text" {
                    if let Some(txt) = item["text"].as_str() {
                        text_buf.push_str(txt);
                    }
                } else if item["type"] == "tool_use" {
                    let id = item["id"].as_str().unwrap_or("").to_string();
                    let name = item["name"].as_str().unwrap_or("").to_string();
                    let input = item["input"].clone();
                    tool_calls.push(ToolCall {
                        id,
                        name,
                        arguments: input,
                    });
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
        msg.provider = Some("anthropic".to_string());
        msg.model = Some(options.model.clone());
        Ok(msg)
    }

    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        self.validate_api_key()?;
        let (system_prompt, formatted_msgs) = anthropic_messages(messages);

        let mut body = json!({
            "model": options.model,
            "max_tokens": options.max_tokens.unwrap_or(sparky_config::DEFAULT_MAX_OUTPUT_TOKENS),
            "messages": formatted_msgs,
            "stream": true,
        });
        if !system_prompt.is_empty() {
            body["system"] = json!(system_prompt);
        }
        if !options.tools.is_empty() {
            body["tools"] = json!(anthropic_tools(&options.tools));
        }
        if let Some(effort) = options.reasoning_effort.as_deref() {
            body["output_config"] = json!({ "effort": effort });
        }

        let encoded = crate::request_body::encode_json(&body, self.supports_request_gzip())?;
        let resp = send_with_retry("anthropic", || async {
            let mut request = self
                .client
                .post(format!("{}/messages", self.base_url))
                .header("x-api-key", &self.api_key)
                .header("anthropic-version", "2023-06-01")
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(encoded.bytes.clone());
            if encoded.compressed {
                request = request.header(reqwest::header::CONTENT_ENCODING, "gzip");
            }
            request.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err = resp.text().await?;
            let hint = if matches!(status.as_u16(), 401 | 403) {
                " Check that ANTHROPIC_API_KEY is valid and authorized for this model."
            } else {
                ""
            };
            anyhow::bail!("Anthropic API error (HTTP {}): {}{}", status, err, hint);
        }

        Ok(stream_parser::anthropic(resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_gzip_is_limited_to_the_canonical_anthropic_endpoint() {
        assert!(AnthropicProvider::new("", None).supports_request_gzip());
        assert!(
            !AnthropicProvider::new("", Some("https://gateway.example/v1".into()))
                .supports_request_gzip()
        );
    }
}
