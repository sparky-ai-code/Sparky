use crate::codex_auth::valid_codex_credentials;
use crate::provider::{CompletionOptions, EventStream, LlmProvider};
use crate::types::{AssistantMessageEvent, ContentPart, Message, Role, ToolCall, UsageStats};
use async_trait::async_trait;
use futures::StreamExt;
use serde_json::{json, Value};
use std::future::Future;
use std::time::Duration;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(Clone)]
pub struct CodexProvider {
    client: reqwest::Client,
}

const MAX_CODEX_ATTEMPTS: u32 = 2;
const MAX_CODEX_STREAM_RETRIES: u32 = 5;
const INITIAL_CODEX_STREAM_RETRY_DELAY: Duration = Duration::from_millis(200);
const MAX_CODEX_STREAM_RETRY_DELAY: Duration = Duration::from_secs(2);

impl CodexProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(20))
                .pool_idle_timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("valid Codex HTTP client configuration"),
        }
    }

    fn request_body(messages: &[Message], options: &CompletionOptions, _stream: bool) -> Value {
        fn input_content(message: &Message) -> Value {
            let mut parts = Vec::new();
            for part in &message.content {
                match part {
                    ContentPart::Text { text } => {
                        parts.push(json!({ "type": "input_text", "text": text }));
                    }
                    ContentPart::Image { data, mime_type } => {
                        parts.push(json!({
                            "type": "input_image",
                            "image_url": format!("data:{mime_type};base64,{data}"),
                        }));
                    }
                    ContentPart::Thinking { thinking, .. } => {
                        parts.push(json!({ "type": "input_text", "text": thinking }));
                    }
                    ContentPart::ProviderState { .. } => {}
                }
            }
            if parts.len() == 1 && parts[0]["type"] == "input_text" {
                parts.pop().unwrap()["text"].clone()
            } else {
                Value::Array(parts)
            }
        }

        let mut input = Vec::new();
        for message in messages {
            match message.role {
                Role::System => {
                    input.push(json!({ "role": "developer", "content": message.text() }))
                }
                Role::User | Role::Custom(_) => {
                    input.push(json!({ "role": "user", "content": input_content(message) }))
                }
                Role::Assistant => {
                    for part in &message.content {
                        if let ContentPart::ProviderState { provider, data } = part {
                            if provider == "openai-codex" {
                                input.push(data.clone());
                            }
                        }
                    }
                    if !message.text().is_empty() {
                        input.push(json!({ "role": "assistant", "content": message.text() }));
                    }
                    for call in message.tool_calls.clone().unwrap_or_default() {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.name,
                            "arguments": call.arguments.to_string(),
                        }));
                    }
                }
                Role::Tool => {
                    if let Some(result) = &message.tool_result {
                        input.push(json!({
                            "type": "function_call_output",
                            "call_id": result.tool_call_id,
                            "output": result.output,
                        }));
                    }
                }
            }
        }
        let tools = options
            .tools
            .iter()
            .map(|tool| {
                json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": false,
                })
            })
            .collect::<Vec<_>>();
        let mut body = json!({
            "model": options.model,
            "input": input,
            "tools": tools,
            "text": { "verbosity": "low" },
            "include": ["reasoning.encrypted_content"],
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "store": false,
            // ChatGPT Codex Responses requires streaming, including for
            // internal summary/compaction requests.
            "stream": true,
        });
        if let Some(effort) = options
            .reasoning_effort
            .as_deref()
            .filter(|value| !value.trim().is_empty() && *value != "none")
        {
            body["reasoning"] = json!({ "effort": effort, "summary": "auto" });
        }
        body
    }

    async fn send(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<reqwest::Response> {
        let request_body = Self::request_body(messages, options, true);
        for attempt in 1..=MAX_CODEX_ATTEMPTS {
            let credentials = valid_codex_credentials().await?;
            let response = self
                .client
                .post("https://chatgpt.com/backend-api/codex/responses")
                .bearer_auth(credentials.access)
                .header("chatgpt-account-id", credentials.account_id)
                .header("originator", "sparky")
                .header("OpenAI-Beta", "responses=experimental")
                .header("Accept", "text/event-stream")
                .header(
                    "User-Agent",
                    concat!("sparky-rust/", env!("CARGO_PKG_VERSION")),
                )
                .json(&request_body)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status();
                    let retryable = status.as_u16() == 408
                        || status.as_u16() == 429
                        || status.is_server_error();
                    let body = response.text().await.unwrap_or_default();
                    if retryable && attempt < MAX_CODEX_ATTEMPTS {
                        tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1)))
                            .await;
                        continue;
                    }
                    let detail = provider_error_detail(&body);
                    anyhow::bail!("ChatGPT Codex request failed (HTTP {status}): {detail}");
                }
                Err(error)
                    if attempt < MAX_CODEX_ATTEMPTS
                        && (error.is_connect() || error.is_timeout()) =>
                {
                    tokio::time::sleep(std::time::Duration::from_secs(1 << (attempt - 1))).await;
                }
                Err(error) => {
                    anyhow::bail!(
                        "Unable to reach ChatGPT Codex after {attempt} attempt(s): {error}"
                    )
                }
            }
        }
        anyhow::bail!("Unable to reach ChatGPT Codex after {MAX_CODEX_ATTEMPTS} attempts")
    }
}

impl Default for CodexProvider {
    fn default() -> Self {
        Self::new()
    }
}

fn provider_error_detail(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|value| {
            value["error"]["message"]
                .as_str()
                .or_else(|| value["message"].as_str())
        })
        .unwrap_or(body)
        .trim();
    if detail.is_empty() {
        return "The provider returned no error details".to_string();
    }
    detail.chars().take(2_000).collect()
}

fn stream_error_detail(event: &Value) -> String {
    event["error"]["message"]
        .as_str()
        .or_else(|| event["response"]["error"]["message"].as_str())
        .or_else(|| event["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| event.to_string().chars().take(2_000).collect())
}

fn codex_stream_retry_delay(retry_index: u32) -> Duration {
    INITIAL_CODEX_STREAM_RETRY_DELAY
        .checked_mul(2_u32.saturating_pow(retry_index))
        .unwrap_or(MAX_CODEX_STREAM_RETRY_DELAY)
        .min(MAX_CODEX_STREAM_RETRY_DELAY)
}

fn can_retry_codex_stream(retry_count: u32, saw_output: bool) -> bool {
    !saw_output && retry_count < MAX_CODEX_STREAM_RETRIES
}

async fn wait_for_codex_stream_retry(
    retry_count: &mut u32,
    saw_output: bool,
    detail: &str,
) -> bool {
    if !can_retry_codex_stream(*retry_count, saw_output) {
        return false;
    }

    let delay = codex_stream_retry_delay(*retry_count);
    *retry_count += 1;
    tracing::warn!(
        retry_attempt = *retry_count,
        max_retries = MAX_CODEX_STREAM_RETRIES,
        delay_ms = delay.as_millis() as u64,
        error = detail,
        "Retrying ChatGPT response after a pre-output stream disconnect"
    );
    tokio::time::sleep(delay).await;
    true
}

#[derive(Debug, PartialEq)]
enum CodexStreamOutcome {
    Completed,
    RetryableDisconnect(String),
    Failed(String),
}

fn codex_response_chunks(
    response: reqwest::Response,
) -> futures::stream::BoxStream<'static, Result<Vec<u8>, String>> {
    response
        .bytes_stream()
        .map(|chunk| {
            chunk
                .map(|bytes| bytes.to_vec())
                .map_err(|error| error.to_string())
        })
        .boxed()
}

async fn forward_codex_stream<S>(
    mut chunks: S,
    tx: &tokio::sync::mpsc::UnboundedSender<AssistantMessageEvent>,
) -> CodexStreamOutcome
where
    S: futures::Stream<Item = Result<Vec<u8>, String>> + Unpin,
{
    let mut buffer = String::new();
    let mut saw_output = false;
    let mut calls: std::collections::HashMap<u64, (String, String)> =
        std::collections::HashMap::new();

    while let Some(chunk) = chunks.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                let detail =
                    format!("ChatGPT response stream disconnected before completion: {error}");
                return if saw_output {
                    CodexStreamOutcome::Failed(detail)
                } else {
                    CodexStreamOutcome::RetryableDisconnect(detail)
                };
            }
        };
        buffer.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(end) = buffer.find('\n') {
            let line = buffer[..end].trim().to_string();
            buffer.drain(..=end);
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data == "[DONE]" {
                let detail = if saw_output {
                    "ChatGPT ended the response stream without a completion event. Your work was saved; retry the message to continue."
                } else {
                    "ChatGPT ended the response stream before sending any output."
                };
                return if saw_output {
                    CodexStreamOutcome::Failed(detail.into())
                } else {
                    CodexStreamOutcome::RetryableDisconnect(detail.into())
                };
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match event["type"].as_str().unwrap_or_default() {
                "response.output_text.delta" => {
                    if let Some(delta) = event["delta"].as_str() {
                        saw_output = true;
                        let _ = tx.send(AssistantMessageEvent::TextDelta(delta.into()));
                    }
                }
                "response.reasoning_summary_text.delta" => {
                    if let Some(delta) = event["delta"].as_str() {
                        saw_output = true;
                        let _ = tx.send(AssistantMessageEvent::ThinkingDelta(delta.into()));
                    }
                }
                "response.output_item.done" if event["item"]["type"] == "reasoning" => {
                    if let Some(encrypted_content) = event["item"]["encrypted_content"].as_str() {
                        saw_output = true;
                        let reasoning_item = json!({
                            "type": "reasoning",
                            "id": event["item"]["id"],
                            "encrypted_content": encrypted_content,
                            "summary": event["item"]["summary"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default(),
                        });
                        let _ = tx.send(AssistantMessageEvent::ProviderState(
                            ContentPart::ProviderState {
                                provider: "openai-codex".into(),
                                data: reasoning_item,
                            },
                        ));
                    }
                }
                "response.output_item.added" if event["item"]["type"] == "function_call" => {
                    let index = event["output_index"].as_u64().unwrap_or(0);
                    let id = event["item"]["call_id"]
                        .as_str()
                        .or_else(|| event["item"]["id"].as_str())
                        .unwrap_or_default()
                        .to_string();
                    let name = event["item"]["name"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    calls.insert(index, (id.clone(), name.clone()));
                    saw_output = true;
                    let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                        id,
                        name,
                        arguments_delta: String::new(),
                    });
                }
                "response.function_call_arguments.delta" => {
                    let index = event["output_index"].as_u64().unwrap_or(0);
                    if let Some((id, name)) = calls.get(&index) {
                        saw_output = true;
                        let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                            id: id.clone(),
                            name: name.clone(),
                            arguments_delta: event["delta"].as_str().unwrap_or_default().into(),
                        });
                    }
                }
                "response.completed" => {
                    let usage = &event["response"]["usage"];
                    let input = usage["input_tokens"].as_u64().unwrap_or(0) as u32;
                    let output = usage["output_tokens"].as_u64().unwrap_or(0) as u32;
                    let _ = tx.send(AssistantMessageEvent::Done {
                        usage: Some(UsageStats {
                            prompt_tokens: input,
                            completion_tokens: output,
                            total_tokens: input.saturating_add(output),
                        }),
                    });
                    return CodexStreamOutcome::Completed;
                }
                "error" | "response.failed" => {
                    return CodexStreamOutcome::Failed(stream_error_detail(&event));
                }
                _ => {}
            }
        }
    }

    let detail = if saw_output {
        "ChatGPT closed the response stream before completion. Your session was saved; retry the message to continue."
    } else {
        "ChatGPT closed the response stream before sending any output."
    };
    if saw_output {
        CodexStreamOutcome::Failed(detail.into())
    } else {
        CodexStreamOutcome::RetryableDisconnect(detail.into())
    }
}

async fn drive_codex_streams<S, Reconnect, ReconnectFuture>(
    tx: tokio::sync::mpsc::UnboundedSender<AssistantMessageEvent>,
    mut chunks: S,
    mut reconnect: Reconnect,
) where
    S: futures::Stream<Item = Result<Vec<u8>, String>> + Send + Unpin,
    Reconnect: FnMut() -> ReconnectFuture,
    ReconnectFuture: Future<Output = Result<S, String>>,
{
    let mut retry_count = 0;
    loop {
        match forward_codex_stream(&mut chunks, &tx).await {
            CodexStreamOutcome::Completed => return,
            CodexStreamOutcome::Failed(detail) => {
                let _ = tx.send(AssistantMessageEvent::Error(detail));
                return;
            }
            CodexStreamOutcome::RetryableDisconnect(detail) => {
                if tx.is_closed()
                    || !wait_for_codex_stream_retry(&mut retry_count, false, &detail).await
                    || tx.is_closed()
                {
                    if !tx.is_closed() {
                        let _ = tx.send(AssistantMessageEvent::Error(detail));
                    }
                    return;
                }
                match reconnect().await {
                    Ok(next_chunks) => chunks = next_chunks,
                    Err(error) => {
                        let _ = tx.send(AssistantMessageEvent::Error(format!(
                            "Unable to reconnect the ChatGPT response stream: {error}"
                        )));
                        return;
                    }
                }
            }
        }
    }
}

#[async_trait]
impl LlmProvider for CodexProvider {
    fn provider_name(&self) -> &str {
        "openai-codex"
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        let mut stream = self.stream(messages, options).await?;
        let mut text = String::new();
        let mut calls = Vec::<ToolCall>::new();
        while let Some(event) = stream.next().await {
            match event {
                AssistantMessageEvent::TextDelta(delta) => text.push_str(&delta),
                AssistantMessageEvent::ToolCallDelta {
                    id,
                    name,
                    arguments_delta,
                } => {
                    if let Some(call) = calls.iter_mut().find(|call| call.id == id) {
                        if !name.is_empty() {
                            call.name = name;
                        }
                        let mut arguments = call.arguments.to_string();
                        if arguments == "{}" {
                            arguments.clear();
                        }
                        arguments.push_str(&arguments_delta);
                        call.arguments =
                            serde_json::from_str(&arguments).unwrap_or_else(|_| json!({}));
                    } else {
                        calls.push(ToolCall {
                            id,
                            name,
                            arguments: serde_json::from_str(&arguments_delta)
                                .unwrap_or_else(|_| json!({})),
                        });
                    }
                }
                AssistantMessageEvent::Error(message) => anyhow::bail!(message),
                AssistantMessageEvent::ThinkingDelta(_)
                | AssistantMessageEvent::ProviderState(_)
                | AssistantMessageEvent::Done { .. } => {}
            }
        }
        let mut message = Message::assistant(text, (!calls.is_empty()).then_some(calls));
        message.provider = Some("openai-codex".to_string());
        message.model = Some(options.model.clone());
        Ok(message)
    }

    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        let response = self.send(messages, options).await?;
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let provider = self.clone();
        let messages = messages.to_vec();
        let options = options.clone();
        tokio::spawn(async move {
            let chunks = codex_response_chunks(response);
            drive_codex_streams(tx, chunks, move || {
                let provider = provider.clone();
                let messages = messages.clone();
                let options = options.clone();
                async move {
                    provider
                        .send(&messages, &options)
                        .await
                        .map(codex_response_chunks)
                        .map_err(|error| error.to_string())
                }
            })
            .await;
        });
        Ok(Box::pin(UnboundedReceiverStream::new(rx)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolParamSchema;

    #[test]
    fn builds_codex_responses_tool_conversation() {
        let messages = vec![
            Message::system("You are Sparky."),
            Message::user("Read the file"),
            Message::assistant(
                "",
                Some(vec![ToolCall {
                    id: "call-1".into(),
                    name: "read".into(),
                    arguments: json!({ "path": "README.md" }),
                }]),
            ),
            Message::tool_result("call-1", "contents", false),
        ];
        let options = CompletionOptions {
            model: "gpt-5.6-sol".into(),
            reasoning_effort: Some("high".into()),
            tools: vec![ToolParamSchema {
                name: "read".into(),
                description: "Read a file".into(),
                parameters: json!({ "type": "object" }),
            }],
            max_tokens: Some(4_096),
            ..Default::default()
        };

        let body = CodexProvider::request_body(&messages, &options, false);
        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["store"], false);
        assert_eq!(body["input"][2]["type"], "function_call");
        assert_eq!(body["input"][3]["type"], "function_call_output");
        assert_eq!(body["tools"][0]["name"], "read");
        assert!(body.get("max_output_tokens").is_none());
        assert_eq!(body["stream"], true);
        assert_eq!(body["reasoning"]["effort"], "high");
    }

    #[test]
    fn replays_encrypted_reasoning_before_the_follow_up() {
        let messages = vec![
            Message::user("The continuity phrase is amber-orchid."),
            Message {
                role: Role::Assistant,
                content: vec![
                    ContentPart::Text {
                        text: "I will remember amber-orchid.".into(),
                    },
                    ContentPart::ProviderState {
                        provider: "openai-codex".into(),
                        data: json!({
                            "type": "reasoning",
                            "id": "reasoning-1",
                            "encrypted_content": "opaque-state",
                            "summary": [],
                        }),
                    },
                ],
                tool_calls: None,
                tool_result: None,
                timestamp: None,
                provider: Some("openai-codex".into()),
                model: Some("gpt-5.6-sol".into()),
            },
            Message::user("What was the continuity phrase?"),
        ];

        let body = CodexProvider::request_body(&messages, &CompletionOptions::default(), false);

        assert_eq!(body["store"], false);
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][1]["type"], "reasoning");
        assert_eq!(body["input"][1]["encrypted_content"], "opaque-state");
        assert_eq!(body["input"][2]["role"], "assistant");
        assert_eq!(body["input"][3]["role"], "user");
    }

    #[test]
    fn includes_user_images_as_responses_input_parts() {
        let messages = vec![Message::user_with_content(vec![
            ContentPart::Text {
                text: "Describe this".into(),
            },
            ContentPart::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
            },
        ])];
        let body = CodexProvider::request_body(&messages, &CompletionOptions::default(), false);
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(
            body["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,aGVsbG8="
        );
        assert_eq!(body["stream"], true);
    }

    #[tokio::test]
    async fn retries_a_disconnect_before_output_and_completes_the_stream() {
        use futures::stream;

        let initial = stream::iter(vec![Err("error decoding response body".to_string())]).boxed();
        let completed = format!(
            "data: {}\n",
            json!({
                "type": "response.completed",
                "response": {
                    "usage": { "input_tokens": 12, "output_tokens": 3 }
                }
            })
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut reconnects = 0;

        drive_codex_streams(tx, initial, || {
            reconnects += 1;
            std::future::ready(Ok(
                stream::iter(vec![Ok(completed.clone().into_bytes())]).boxed()
            ))
        })
        .await;

        assert_eq!(reconnects, 1);
        assert!(matches!(
            rx.recv().await,
            Some(AssistantMessageEvent::Done {
                usage: Some(UsageStats {
                    prompt_tokens: 12,
                    completion_tokens: 3,
                    total_tokens: 15,
                }),
            })
        ));
        assert!(rx.recv().await.is_none());
    }

    #[tokio::test]
    async fn does_not_retry_after_model_output_has_started() {
        use futures::stream;

        let initial = stream::iter(vec![
            Ok(b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n".to_vec()),
            Err("error decoding response body".to_string()),
        ])
        .boxed();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut reconnects = 0;

        drive_codex_streams(tx, initial, || {
            reconnects += 1;
            std::future::ready(Ok(stream::empty().boxed()))
        })
        .await;

        assert_eq!(reconnects, 0);
        assert!(matches!(
            rx.recv().await,
            Some(AssistantMessageEvent::TextDelta(text)) if text == "partial"
        ));
        assert!(matches!(
            rx.recv().await,
            Some(AssistantMessageEvent::Error(message))
                if message.contains("error decoding response body")
        ));
        assert!(rx.recv().await.is_none());
    }
}
