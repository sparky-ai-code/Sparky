use crate::provider::EventStream;
use crate::types::{AssistantMessageEvent, UsageStats};
use futures::StreamExt;
use reqwest::Response;
use serde_json::Value;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(Default)]
struct SseDecoder {
    buffer: String,
}

fn token_count(value: &Value, field: &str) -> u32 {
    value[field].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32
}

fn openai_usage(value: &Value) -> Option<UsageStats> {
    let usage = value.get("usage")?;
    if usage.is_null() {
        return None;
    }
    Some(UsageStats {
        prompt_tokens: token_count(usage, "prompt_tokens"),
        completion_tokens: token_count(usage, "completion_tokens"),
        total_tokens: token_count(usage, "total_tokens"),
    })
}

fn anthropic_usage(value: &Value, previous: Option<&UsageStats>) -> Option<UsageStats> {
    let usage = match value["type"].as_str() {
        Some("message_start") => value["message"].get("usage")?,
        Some("message_delta") => value.get("usage")?,
        _ => return previous.cloned(),
    };
    let prompt_tokens = token_count(usage, "input_tokens")
        .max(previous.map(|stats| stats.prompt_tokens).unwrap_or(0));
    let completion_tokens = token_count(usage, "output_tokens")
        .max(previous.map(|stats| stats.completion_tokens).unwrap_or(0));
    Some(UsageStats {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens.saturating_add(completion_tokens),
    })
}

fn gemini_usage(value: &Value) -> Option<UsageStats> {
    let usage = value.get("usageMetadata")?;
    Some(UsageStats {
        prompt_tokens: token_count(usage, "promptTokenCount"),
        completion_tokens: token_count(usage, "candidatesTokenCount"),
        total_tokens: token_count(usage, "totalTokenCount"),
    })
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut payloads = Vec::new();

        while let Some(line_end) = self.buffer.find('\n') {
            let line = self.buffer[..line_end].trim().to_string();
            self.buffer.drain(..=line_end);
            if let Some(data) = line.strip_prefix("data: ") {
                payloads.push(data.to_string());
            }
        }

        payloads
    }
}

pub(crate) fn openai(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut tool_calls: Vec<(String, String)> = Vec::new();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                if data == "[DONE]" {
                    let _ = tx.send(AssistantMessageEvent::Done { usage });
                    return;
                }
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "OpenAI returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                let delta = &value["choices"][0]["delta"];
                if let Some(parsed_usage) = openai_usage(&value) {
                    usage = Some(parsed_usage);
                }
                if let Some(text) = delta["content"].as_str() {
                    let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                }
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for call in calls {
                        let index = call["index"].as_u64().unwrap_or(0) as usize;
                        while tool_calls.len() <= index {
                            tool_calls.push((String::new(), String::new()));
                        }
                        if let Some(id) = call["id"].as_str() {
                            tool_calls[index].0 = id.to_string();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            tool_calls[index].1 = name.to_string();
                        }
                        let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                            id: tool_calls[index].0.clone(),
                            name: tool_calls[index].1.clone(),
                            arguments_delta: call["function"]["arguments"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        });
                    }
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "OpenAI closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

pub(crate) fn anthropic(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut tool_blocks: Vec<(String, String)> = Vec::new();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "Anthropic returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                usage = anthropic_usage(&value, usage.as_ref());
                match value["type"].as_str().unwrap_or("") {
                    "content_block_start" if value["content_block"]["type"] == "tool_use" => {
                        let index = value["index"].as_u64().unwrap_or(0) as usize;
                        while tool_blocks.len() <= index {
                            tool_blocks.push((String::new(), String::new()));
                        }
                        tool_blocks[index] = (
                            value["content_block"]["id"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            value["content_block"]["name"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        );
                        let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                            id: tool_blocks[index].0.clone(),
                            name: tool_blocks[index].1.clone(),
                            arguments_delta: String::new(),
                        });
                    }
                    "content_block_delta" => {
                        if let Some(text) = value["delta"]["text"].as_str() {
                            let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                        }
                        if let Some(thinking) = value["delta"]["thinking"].as_str() {
                            let _ =
                                tx.send(AssistantMessageEvent::ThinkingDelta(thinking.to_string()));
                        }
                        if let Some(arguments) = value["delta"]["partial_json"].as_str() {
                            let index = value["index"].as_u64().unwrap_or(0) as usize;
                            if let Some((id, name)) = tool_blocks.get(index) {
                                let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                                    id: id.clone(),
                                    name: name.clone(),
                                    arguments_delta: arguments.to_string(),
                                });
                            }
                        }
                    }
                    "message_stop" => {
                        let _ = tx.send(AssistantMessageEvent::Done { usage });
                        return;
                    }
                    "error" => {
                        let message = value["error"]["message"]
                            .as_str()
                            .unwrap_or("Anthropic streaming error")
                            .to_string();
                        let _ = tx.send(AssistantMessageEvent::Error(message));
                        return;
                    }
                    _ => {}
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "Anthropic closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

pub(crate) fn gemini(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "Gemini returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                if let Some(parsed_usage) = gemini_usage(&value) {
                    usage = Some(parsed_usage);
                }
                if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                    for part in parts {
                        if let Some(text) = part["text"].as_str() {
                            let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                        }
                        if let Some(call) = part["functionCall"].as_object() {
                            let name = call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let arguments = call
                                .get("args")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                                id: name.clone(),
                                name,
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
                if value["candidates"][0]["finishReason"].is_string() {
                    let _ = tx.send(AssistantMessageEvent::Done { usage });
                    return;
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "Gemini closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_handles_sse_lines_split_across_chunks() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: {\"part\":").is_empty());
        assert_eq!(
            decoder.push(b"1}\n\ndata: [DONE]\n"),
            vec!["{\"part\":1}", "[DONE]"]
        );
    }

    #[test]
    fn parses_usage_for_each_provider_shape() {
        assert_eq!(
            openai_usage(&serde_json::json!({
                "usage": { "prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13 }
            }))
            .unwrap()
            .total_tokens,
            13
        );

        let anthropic = anthropic_usage(
            &serde_json::json!({
                "type": "message_start",
                "message": { "usage": { "input_tokens": 20, "output_tokens": 1 } }
            }),
            None,
        )
        .unwrap();
        let anthropic = anthropic_usage(
            &serde_json::json!({
                "type": "message_delta",
                "usage": { "output_tokens": 5 }
            }),
            Some(&anthropic),
        )
        .unwrap();
        assert_eq!(anthropic.total_tokens, 25);

        assert_eq!(
            gemini_usage(&serde_json::json!({
                "usageMetadata": {
                    "promptTokenCount": 30,
                    "candidatesTokenCount": 7,
                    "totalTokenCount": 37
                }
            }))
            .unwrap()
            .total_tokens,
            37
        );
    }
}
