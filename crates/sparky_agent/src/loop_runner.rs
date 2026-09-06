use futures::{future::join_all, StreamExt};
use sparky_ai::{
    AssistantMessageEvent, CompletionOptions, ContentPart, LlmProvider, Message, ToolCall,
    UsageStats,
};
use sparky_compaction::CompactionEngine;
use sparky_config::{max_output_tokens_for_model, DEFAULT_CONTEXT_WINDOW_TOKENS};
use sparky_extensions::{EventBus, SparkyEvent};
use sparky_prompt::PromptBuilder;
use sparky_session::SessionManager;
use sparky_tools::{ToolExecutionMode, ToolExecutionResult, ToolRegistry, END_TASK_TOOL_NAME};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionMode {
    Build,
    Plan,
}

pub struct AgentLoopOptions {
    pub cwd: String,
    pub workspace_context: bool,
    pub model_name: String,
    pub temperature: Option<f32>,
    pub reasoning_effort: Option<String>,
    pub append_system_prompt: Option<String>,
    pub context_window_tokens: Option<usize>,
    pub memory_context: Option<String>,
    pub interaction_mode: InteractionMode,
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use futures::stream;
    use sparky_ai::EventStream;
    use sparky_tools::{Tool, ToolExecutionResult};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct StreamingProvider;

    struct EndTaskProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct MalformedToolArgumentsProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ParallelToolsProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ContextRecoveryProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ContinuityProvider {
        calls: std::sync::atomic::AtomicUsize,
        saw_persisted_history: std::sync::atomic::AtomicBool,
    }

    struct IncompleteStreamProvider;

    struct BarrierTool {
        name: &'static str,
        barrier: Arc<tokio::sync::Barrier>,
    }

    #[async_trait]
    impl Tool for BarrierTool {
        fn name(&self) -> &str {
            self.name
        }

        fn label(&self) -> &str {
            self.name
        }

        fn description(&self) -> &str {
            "Wait for another parallel tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        fn execution_mode(&self) -> ToolExecutionMode {
            ToolExecutionMode::Parallel
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            self.barrier.wait().await;
            Ok(ToolExecutionResult::success(self.name))
        }
    }

    #[async_trait]
    impl LlmProvider for StreamingProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Hel".to_string()),
                AssistantMessageEvent::TextDelta("lo".to_string()),
                AssistantMessageEvent::Done {
                    usage: Some(UsageStats {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                    }),
                },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for IncompleteStreamProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("partial output".to_string()),
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for EndTaskProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            assert!(options
                .tools
                .iter()
                .any(|tool| tool.name == END_TASK_TOOL_NAME));
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(call, 0, "end_task should stop the agent loop immediately");
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta(
                    "Implemented and verified the requested fix.".to_string(),
                ),
                AssistantMessageEvent::ToolCallDelta {
                    id: "end-task-call".to_string(),
                    name: END_TASK_TOOL_NAME.to_string(),
                    arguments_delta: r#"{"summary":"Implemented and verified the requested fix."}"#
                        .to_string(),
                },
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for MalformedToolArgumentsProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "bad-call".to_string(),
                        name: "read".to_string(),
                        arguments_delta: r#"{"path":"README.md""#.to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let parse_error = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .find(|result| result.tool_call_id == "bad-call")
                .expect("malformed arguments should be returned to the model");
            assert!(parse_error.is_error);
            // The truncated JSON triggers the EOF-specific helpful message
            assert!(
                parse_error.output.contains("truncated")
                    || parse_error
                        .output
                        .contains("Failed to parse arguments JSON")
            );

            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Recovered from malformed arguments.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for ParallelToolsProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "call-first".to_string(),
                        name: "parallel-first".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::ToolCallDelta {
                        id: "call-second".to_string(),
                        name: "parallel-second".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let result_ids: Vec<_> = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .map(|result| result.tool_call_id.as_str())
                .collect();
            assert_eq!(result_ids, vec!["call-first", "call-second"]);
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Both tools completed.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for ContextRecoveryProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            match self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => Ok(Box::pin(stream::iter(vec![AssistantMessageEvent::Error(
                    "context_length_exceeded".to_string(),
                )]))),
                1 => Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("Conversation compacted.".to_string()),
                    AssistantMessageEvent::Done { usage: None },
                ]))),
                _ => Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("Recovered in the same session.".to_string()),
                    AssistantMessageEvent::Done { usage: None },
                ]))),
            }
        }
    }

    #[async_trait]
    impl LlmProvider for ContinuityProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let transcript = messages
                .iter()
                .map(Message::text)
                .collect::<Vec<_>>()
                .join("\n");
            if call == 0 {
                assert!(transcript.contains("amber-orchid"));
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("I will remember amber-orchid.".to_string()),
                    AssistantMessageEvent::ProviderState(ContentPart::ProviderState {
                        provider: "openai-codex".to_string(),
                        data: serde_json::json!({
                            "type": "reasoning",
                            "id": "reasoning-1",
                            "encrypted_content": "opaque-state",
                            "summary": [],
                        }),
                    }),
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            assert_eq!(call, 1, "the recall turn should use one provider request");
            assert!(transcript.contains("The continuity phrase is amber-orchid."));
            assert!(transcript.contains("I will remember amber-orchid."));
            assert!(transcript.contains("What was the continuity phrase?"));
            assert!(messages.iter().any(|message| {
                message.content.iter().any(|part| {
                    matches!(
                        part,
                        ContentPart::ProviderState { provider, data }
                            if provider == "openai-codex"
                                && data["encrypted_content"] == "opaque-state"
                    )
                })
            }));
            self.saw_persisted_history
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("amber-orchid".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    fn temporary_workspace() -> PathBuf {
        static NEXT_WORKSPACE_ID: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sparky-streaming-test-{}-{suffix}-{}",
            std::process::id(),
            NEXT_WORKSPACE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    async fn remove_temporary_workspace(workspace: PathBuf) {
        let mut last_error = None;
        for _ in 0..10 {
            match tokio::fs::remove_dir_all(&workspace).await {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => last_error = Some(error),
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!(
            "failed to remove temporary workspace {}: {}",
            workspace.display(),
            last_error.expect("cleanup attempts should record an error")
        );
    }

    #[tokio::test]
    async fn forwards_deltas_while_reconstructing_the_final_message() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let usage_events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let agent = AgentLoop::new(
            Arc::new(StreamingProvider),
            ToolRegistry::new(),
            {
                let usage_events_for_bus = usage_events.clone();
                let mut event_bus = EventBus::new();
                event_bus.subscribe(move |event| {
                    if let SparkyEvent::UsageUpdate {
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                        cumulative_total_tokens,
                    } = event
                    {
                        usage_events_for_bus.lock().unwrap().push((
                            *prompt_tokens,
                            *completion_tokens,
                            *total_tokens,
                            *cumulative_total_tokens,
                        ));
                    }
                });
                event_bus
            },
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );
        let mut deltas = Vec::new();

        let response = agent
            .run_turn_streaming("Say hello", &mut session, |event| {
                if let AssistantMessageEvent::TextDelta(delta) = event {
                    deltas.push(delta.clone());
                }
            })
            .await
            .unwrap();

        assert_eq!(deltas, vec!["Hel", "lo"]);
        assert_eq!(response, "Hello");
        assert_eq!(*usage_events.lock().unwrap(), vec![(10, 2, 12, 12)]);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn refuses_to_treat_an_incomplete_provider_stream_as_a_completed_turn() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let agent = AgentLoop::new(
            Arc::new(IncompleteStreamProvider),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let error = agent
            .run_turn_streaming("Continue the task", &mut session, |_| {})
            .await
            .expect_err("an incomplete stream must fail the turn");

        assert!(error
            .to_string()
            .contains("ended before a completion event"));
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn refuses_to_treat_an_incomplete_max_turn_response_as_completed() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let agent = AgentLoop::new(
            Arc::new(IncompleteStreamProvider),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );
        let mut session = SessionManager::create_new(&workspace.to_string_lossy(), None)
            .await
            .unwrap();

        let error = agent
            .run_turn_streaming("Finish the task", &mut session, |_| {})
            .await
            .expect_err("the final response also requires a completion event");

        assert!(error
            .to_string()
            .contains("ended before a completion event"));
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn compacts_and_retries_context_overflow_without_starting_a_new_session() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        for index in 0..3 {
            session
                .append_message(Message::user(format!("prior-{index}:{}", "x".repeat(100))))
                .await
                .unwrap();
        }

        let provider = Arc::new(ContextRecoveryProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                context_window_tokens: Some(1_000),
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn_streaming("continue the same conversation", &mut session, |_| {})
            .await
            .unwrap();

        assert_eq!(response, "Recovered in the same session.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        let context = session.build_context_messages();
        assert!(context
            .iter()
            .any(|message| message.text().contains("[Compaction Summary]")));
        assert_eq!(
            context
                .iter()
                .filter(|message| message.text().contains("continue the same conversation"))
                .count(),
            1
        );

        let session_id = session.session_id().to_string();
        drop(agent);
        drop(provider);
        drop(session);
        let resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        let resumed_context = resumed.build_context_messages();
        assert!(resumed_context
            .iter()
            .any(|message| message.text().contains("[Compaction Summary]")));
        assert_eq!(
            resumed_context
                .iter()
                .filter(|message| message.text().contains("continue the same conversation"))
                .count(),
            1
        );
        drop(resumed);

        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn reloads_the_same_session_transcript_for_two_turn_recall() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let provider = Arc::new(ContinuityProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
            saw_persisted_history: std::sync::atomic::AtomicBool::new(false),
        });
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let session_id = session.session_id().to_string();
        let first_agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let first_response = first_agent
            .run_turn_streaming(
                "The continuity phrase is amber-orchid.",
                &mut session,
                |_| {},
            )
            .await
            .unwrap();
        assert_eq!(first_response, "I will remember amber-orchid.");

        drop(first_agent);
        drop(session);
        let mut resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        assert_eq!(resumed.session_id(), session_id);
        let second_agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let second_response = second_agent
            .run_turn_streaming("What was the continuity phrase?", &mut resumed, |_| {})
            .await
            .unwrap();

        assert_eq!(second_response, "amber-orchid");
        assert!(provider
            .saw_persisted_history
            .load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(second_agent);
        drop(resumed);
        drop(provider);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn hidden_end_task_closes_the_turn_without_emitting_a_tool_call() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let observed_events = Arc::new(std::sync::Mutex::new(Vec::<SparkyEvent>::new()));
        let observed_events_for_bus = observed_events.clone();
        let mut event_bus = EventBus::new();
        event_bus.subscribe(move |event| {
            observed_events_for_bus.lock().unwrap().push(event.clone());
        });
        let provider = Arc::new(EndTaskProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            event_bus,
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Implement the requested fix", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Implemented and verified the requested fix.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let events = observed_events.lock().unwrap();
        assert!(!events.iter().any(|event| matches!(
            event,
            SparkyEvent::ToolExecutionStart { tool_name, .. }
                | SparkyEvent::ToolExecutionEnd { tool_name, .. }
                if tool_name == END_TASK_TOOL_NAME
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event, SparkyEvent::AgentEnd)));
        let messages = session.build_context_messages();
        assert!(messages.iter().any(|message| {
            message
                .tool_calls
                .as_deref()
                .is_some_and(|calls| calls.iter().any(|call| call.name == END_TASK_TOOL_NAME))
        }));
        assert!(messages.iter().any(|message| {
            message
                .tool_result
                .as_ref()
                .is_some_and(|result| result.tool_call_id == "end-task-call")
        }));

        drop(agent);
        drop(provider);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn returns_malformed_tool_arguments_to_the_model_as_an_error_result() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let provider = Arc::new(MalformedToolArgumentsProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Trigger a malformed tool call", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Recovered from malformed arguments.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(agent);
        drop(provider);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn executes_parallel_tools_concurrently_and_records_results_in_call_order() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(BarrierTool {
            name: "parallel-first",
            barrier: barrier.clone(),
        }));
        registry.register(Arc::new(BarrierTool {
            name: "parallel-second",
            barrier,
        }));
        let agent = AgentLoop::new(
            Arc::new(ParallelToolsProvider {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }),
            registry,
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            agent.run_turn("Run both tools", &mut session),
        )
        .await
        .expect("parallel tools should meet at the barrier")
        .unwrap();

        assert_eq!(response, "Both tools completed.");
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }
}

impl Default for AgentLoopOptions {
    fn default() -> Self {
        Self {
            cwd: ".".to_string(),
            workspace_context: true,
            model_name: "gpt-4o".to_string(),
            temperature: Some(0.7),
            reasoning_effort: None,
            append_system_prompt: None,
            context_window_tokens: Some(DEFAULT_CONTEXT_WINDOW_TOKENS),
            memory_context: None,
            interaction_mode: InteractionMode::Build,
        }
    }
}

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    tool_registry: ToolRegistry,
    event_bus: EventBus,
    compaction: CompactionEngine,
    options: AgentLoopOptions,
}

fn is_end_task_tool(tool_call: &ToolCall) -> bool {
    tool_call.name == END_TASK_TOOL_NAME
}

fn is_context_window_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("context_length_exceeded")
        || message.contains("context window")
        || message.contains("contextwindowexceeded")
        || message.contains("maximum context")
}

fn end_task_summary(tool_call: &ToolCall) -> Option<String> {
    tool_call
        .arguments
        .get("summary")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(ToOwned::to_owned)
}

impl AgentLoop {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tool_registry: ToolRegistry,
        event_bus: EventBus,
        options: AgentLoopOptions,
    ) -> Self {
        Self {
            provider,
            tool_registry,
            event_bus,
            compaction: CompactionEngine::default(),
            options,
        }
    }

    pub async fn run_turn(
        &self,
        user_prompt: &str,
        session: &mut SessionManager,
    ) -> anyhow::Result<String> {
        self.run_turn_streaming_with_images(user_prompt, Vec::new(), session, |_| {})
            .await
    }

    pub async fn run_turn_with_images(
        &self,
        user_prompt: &str,
        images: Vec<ContentPart>,
        session: &mut SessionManager,
    ) -> anyhow::Result<String> {
        self.run_turn_streaming_with_images(user_prompt, images, session, |_| {})
            .await
    }

    pub async fn compact_session(&self, session: &mut SessionManager) -> anyhow::Result<bool> {
        let Some(context_window_tokens) = self.options.context_window_tokens else {
            return Ok(false);
        };
        self.compaction
            .compact(
                session,
                self.provider.clone(),
                &self.options.model_name,
                context_window_tokens,
            )
            .await
    }

    async fn compact_session_now(&self, session: &mut SessionManager) -> anyhow::Result<bool> {
        let Some(context_window_tokens) = self.options.context_window_tokens else {
            return Ok(false);
        };
        self.compaction
            .compact_now(
                session,
                self.provider.clone(),
                &self.options.model_name,
                context_window_tokens,
            )
            .await
    }

    pub async fn run_turn_streaming<F>(
        &self,
        user_prompt: &str,
        session: &mut SessionManager,
        on_event: F,
    ) -> anyhow::Result<String>
    where
        F: FnMut(&AssistantMessageEvent),
    {
        self.run_turn_streaming_with_images(user_prompt, Vec::new(), session, on_event)
            .await
    }

    pub async fn run_turn_streaming_with_images<F>(
        &self,
        user_prompt: &str,
        images: Vec<ContentPart>,
        session: &mut SessionManager,
        mut on_event: F,
    ) -> anyhow::Result<String>
    where
        F: FnMut(&AssistantMessageEvent),
    {
        let plan_mode = self.options.interaction_mode == InteractionMode::Plan;
        let tools_schemas = self.tool_registry.get_schemas_for_mode(plan_mode);

        let prompt_builder = PromptBuilder::new(&self.options.cwd)
            .with_workspace_context(self.options.workspace_context)
            .with_append_prompt(self.options.append_system_prompt.clone())
            .with_plan_mode(plan_mode);
        let mut system_prompt = prompt_builder.build().await;
        if let Some(memory_context) = self
            .options
            .memory_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(memory_context);
        }

        self.event_bus.emit(&SparkyEvent::BeforeAgentStart {
            prompt: user_prompt.to_string(),
            system_prompt: system_prompt.clone(),
        });

        // Preserve images as provider-native content instead of reducing the
        // turn to text before it reaches the LLM request builder.
        if !user_prompt.trim().is_empty() || !images.is_empty() {
            let mut content = Vec::with_capacity(1 + images.len());
            if !user_prompt.trim().is_empty() {
                content.push(ContentPart::Text {
                    text: user_prompt.to_string(),
                });
            }
            content.extend(images);
            session
                .append_message(Message::user_with_content(content))
                .await?;
        }

        self.event_bus.emit(&SparkyEvent::AgentStart);

        let mut turn_count = 0;
        let mut final_response = String::new();
        let mut cumulative_usage = UsageStats {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };

        loop {
            turn_count += 1;

            self.event_bus.emit(&SparkyEvent::TurnStart {
                turn_index: turn_count,
            });

            let completion_options = CompletionOptions {
                model: self.options.model_name.clone(),
                temperature: self.options.temperature,
                max_tokens: Some(max_output_tokens_for_model(&self.options.model_name)),
                reasoning_effort: self.options.reasoning_effort.clone(),
                tools: tools_schemas.clone(),
                ..Default::default()
            };

            let mut context_recovery_attempted = false;
            let (text_output, tool_call_parts, provider_state, attempt_usage) = 'completion: loop {
                if let Some(context_window) = self.options.context_window_tokens {
                    self.compaction
                        .compact(
                            session,
                            self.provider.clone(),
                            &self.options.model_name,
                            context_window,
                        )
                        .await?;
                }

                let mut context_messages = vec![Message::system(&system_prompt)];
                context_messages.extend(session.build_context_messages());
                let mut event_stream = match self
                    .provider
                    .stream(&context_messages, &completion_options)
                    .await
                {
                    Ok(stream) => stream,
                    Err(error) => {
                        if !context_recovery_attempted
                            && is_context_window_error(&error.to_string())
                        {
                            context_recovery_attempted = true;
                            if self.compact_session_now(session).await? {
                                continue 'completion;
                            }
                        }
                        tracing::error!("LLM stream failed: {}", error);
                        return Err(error);
                    }
                };

                let mut text_output = String::new();
                let mut tool_call_parts: Vec<(String, String, String)> = Vec::new();
                let mut provider_state = Vec::new();
                let mut attempt_usage = UsageStats {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                };
                let mut saw_partial_output = false;
                let mut saw_completion = false;
                while let Some(event) = event_stream.next().await {
                    on_event(&event);
                    match event {
                        AssistantMessageEvent::TextDelta(delta) => {
                            saw_partial_output = true;
                            text_output.push_str(&delta);
                        }
                        AssistantMessageEvent::ToolCallDelta {
                            id,
                            name,
                            arguments_delta,
                        } => {
                            saw_partial_output = true;
                            if let Some((_, stored_name, stored_arguments)) = tool_call_parts
                                .iter_mut()
                                .find(|(stored_id, _, _)| *stored_id == id)
                            {
                                if !name.is_empty() {
                                    *stored_name = name;
                                }
                                stored_arguments.push_str(&arguments_delta);
                            } else {
                                tool_call_parts.push((id, name, arguments_delta));
                            }
                        }
                        AssistantMessageEvent::Error(message) => {
                            if !saw_partial_output
                                && !context_recovery_attempted
                                && is_context_window_error(&message)
                            {
                                context_recovery_attempted = true;
                                if self.compact_session_now(session).await? {
                                    continue 'completion;
                                }
                            }
                            anyhow::bail!(message)
                        }
                        AssistantMessageEvent::Done { usage: Some(usage) } => {
                            Self::accumulate_usage(&mut attempt_usage, &usage);
                            saw_completion = true;
                            break;
                        }
                        AssistantMessageEvent::ProviderState(state) => {
                            provider_state.push(state);
                        }
                        AssistantMessageEvent::ThinkingDelta(_) => {}
                        AssistantMessageEvent::Done { usage: None } => {
                            saw_completion = true;
                            break;
                        }
                    }
                }
                if !saw_completion {
                    anyhow::bail!(
                        "LLM stream ended before a completion event; refusing to treat partial output as a completed turn"
                    );
                }
                break (text_output, tool_call_parts, provider_state, attempt_usage);
            };
            self.record_usage(&mut cumulative_usage, &attempt_usage);

            let mut malformed_arguments = HashMap::new();
            let tool_calls: Vec<ToolCall> = tool_call_parts
                .into_iter()
                .map(|(id, name, arguments)| {
                    let parsed_arguments = match serde_json::from_str(&arguments) {
                        Ok(arguments) => arguments,
                        Err(err) => {
                            let message = if err.is_eof() {
                                "The tool call JSON was truncated mid-content. The file content is too large for a single write. Split the content into smaller files or write the file in multiple smaller steps. Do NOT retry the exact same large write.".to_string()
                            } else {
                                format!("Failed to parse arguments JSON: {err}")
                            };
                            tracing::error!(
                                tool_call_id = %id,
                                tool_name = %name,
                                error = %err,
                                arguments_len = arguments.len(),
                                "LLM returned malformed tool arguments"
                            );
                            malformed_arguments.insert(id.clone(), message);
                            serde_json::json!({})
                        }
                    };

                    ToolCall {
                        id,
                        name,
                        arguments: parsed_arguments,
                    }
                })
                .collect();
            let mut assistant_msg = Message::assistant(
                text_output.clone(),
                if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
            );
            assistant_msg.provider = Some(self.provider.provider_name().to_string());
            assistant_msg.model = Some(self.options.model_name.clone());
            assistant_msg.content.extend(provider_state);

            let tool_calls = assistant_msg.tool_calls.clone().unwrap_or_default();
            let end_task_call_index = tool_calls.iter().position(|call| {
                is_end_task_tool(call) && !malformed_arguments.contains_key(&call.id)
            });
            let terminal_summary =
                end_task_call_index.and_then(|index| end_task_summary(&tool_calls[index]));
            if let Some(summary) = terminal_summary.as_ref() {
                if text_output.trim().is_empty() {
                    assistant_msg.content = vec![ContentPart::Text {
                        text: summary.clone(),
                    }];
                } else if !text_output.contains(summary) {
                    assistant_msg.content.push(ContentPart::Text {
                        text: format!("\n\n{summary}"),
                    });
                }
            }

            if !text_output.trim().is_empty() {
                final_response.push_str(&text_output);
            }

            session.append_message(assistant_msg.clone()).await?;

            if tool_calls.is_empty() {
                self.event_bus.emit(&SparkyEvent::TurnEnd {
                    turn_index: turn_count,
                });
                break;
            }

            // `end_task` is a control-only tool. It is exposed to the model so
            // the model can explicitly close a completed task, but its own
            // lifecycle is never emitted to the UI. A valid summary is
            // required before it can terminate the agent loop.
            if let Some(end_task_call_index) = end_task_call_index {
                for (index, tool_call) in tool_calls.iter().enumerate() {
                    if index > end_task_call_index {
                        self.append_tool_result(
                            tool_call,
                            ToolExecutionResult::error("Task ended before this tool was executed."),
                            session,
                        )
                        .await?;
                        continue;
                    }

                    if let Some(error) = malformed_arguments.remove(&tool_call.id) {
                        self.record_tool_call_error(tool_call, error, session)
                            .await?;
                        continue;
                    }

                    let result = if index == end_task_call_index {
                        self.execute_tool_call_result_silent(tool_call).await
                    } else {
                        self.execute_tool_call_result(tool_call).await
                    };
                    self.append_tool_result(tool_call, result, session).await?;
                }

                let summary = terminal_summary
                    .as_deref()
                    .expect("validated end_task call should include a summary");
                if text_output.trim().is_empty() {
                    final_response.push_str(summary);
                    on_event(&AssistantMessageEvent::TextDelta(summary.to_string()));
                } else if !text_output.contains(summary) {
                    let suffix = format!("\n\n{summary}");
                    final_response.push_str(&suffix);
                    on_event(&AssistantMessageEvent::TextDelta(suffix));
                }
                self.event_bus.emit(&SparkyEvent::TurnEnd {
                    turn_index: turn_count,
                });
                break;
            }

            // Execute sequential tools in place and adjacent parallel tools as a batch.
            let mut tool_index = 0;
            while tool_index < tool_calls.len() {
                let tool_call = &tool_calls[tool_index];
                if is_end_task_tool(tool_call) {
                    let result = self.execute_tool_call_result_silent(tool_call).await;
                    self.append_tool_result(tool_call, result, session).await?;
                    tool_index += 1;
                    continue;
                }
                if let Some(error) = malformed_arguments.remove(&tool_call.id) {
                    self.record_tool_call_error(tool_call, error, session)
                        .await?;
                    tool_index += 1;
                    continue;
                }

                if self.execution_mode(tool_call) == ToolExecutionMode::Sequential {
                    self.execute_tool_call(tool_call, session).await?;
                    tool_index += 1;
                    continue;
                }

                let mut batch_end = tool_index + 1;
                while batch_end < tool_calls.len()
                    && !malformed_arguments.contains_key(&tool_calls[batch_end].id)
                    && self.execution_mode(&tool_calls[batch_end]) == ToolExecutionMode::Parallel
                {
                    batch_end += 1;
                }

                let results = join_all(
                    tool_calls[tool_index..batch_end]
                        .iter()
                        .map(|call| self.execute_tool_call_result(call)),
                )
                .await;
                for (call, result) in tool_calls[tool_index..batch_end].iter().zip(results) {
                    self.append_tool_result(call, result, session).await?;
                }
                tool_index = batch_end;
            }

            self.event_bus.emit(&SparkyEvent::TurnEnd {
                turn_index: turn_count,
            });
        }

        self.event_bus.emit(&SparkyEvent::AgentEnd);
        Ok(final_response)
    }

    async fn execute_tool_call(
        &self,
        tool_call: &ToolCall,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        let result = self.execute_tool_call_result(tool_call).await;
        self.append_tool_result(tool_call, result, session).await
    }

    fn record_usage(&self, cumulative: &mut UsageStats, usage: &UsageStats) {
        Self::accumulate_usage(cumulative, usage);
        if usage.prompt_tokens == 0 && usage.completion_tokens == 0 && usage.total_tokens == 0 {
            return;
        }
        self.event_bus.emit(&SparkyEvent::UsageUpdate {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cumulative_total_tokens: cumulative.total_tokens as u64,
        });
    }

    fn accumulate_usage(cumulative: &mut UsageStats, usage: &UsageStats) {
        cumulative.prompt_tokens = cumulative.prompt_tokens.saturating_add(usage.prompt_tokens);
        cumulative.completion_tokens = cumulative
            .completion_tokens
            .saturating_add(usage.completion_tokens);
        cumulative.total_tokens = cumulative.total_tokens.saturating_add(usage.total_tokens);
    }

    fn execution_mode(&self, tool_call: &ToolCall) -> ToolExecutionMode {
        self.tool_registry
            .get_for_mode(
                &tool_call.name,
                self.options.interaction_mode == InteractionMode::Plan,
            )
            .map(|tool| tool.execution_mode())
            .unwrap_or(ToolExecutionMode::Sequential)
    }

    async fn execute_tool_call_result(&self, tool_call: &ToolCall) -> ToolExecutionResult {
        self.execute_tool_call_result_with_events(tool_call, true)
            .await
    }

    async fn execute_tool_call_result_silent(&self, tool_call: &ToolCall) -> ToolExecutionResult {
        self.execute_tool_call_result_with_events(tool_call, false)
            .await
    }

    async fn execute_tool_call_result_with_events(
        &self,
        tool_call: &ToolCall,
        emit_events: bool,
    ) -> ToolExecutionResult {
        if emit_events {
            self.event_bus.emit(&SparkyEvent::ToolExecutionStart {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_call.name.clone(),
                arguments: tool_call.arguments.clone(),
            });
        }

        let result = if let Some(tool) = self.tool_registry.get_for_mode(
            &tool_call.name,
            self.options.interaction_mode == InteractionMode::Plan,
        ) {
            match tool
                .execute(tool_call.arguments.clone(), &self.options.cwd)
                .await
            {
                Ok(res) => res,
                Err(e) => ToolExecutionResult::error(format!("Tool execution error: {}", e)),
            }
        } else {
            ToolExecutionResult::error(format!("Unknown tool: {}", tool_call.name))
        };

        if emit_events {
            self.event_bus.emit(&SparkyEvent::ToolExecutionEnd {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_call.name.clone(),
                output: result.output.clone(),
                is_error: result.is_error,
            });
        }

        result
    }

    async fn append_tool_result(
        &self,
        tool_call: &ToolCall,
        result: sparky_tools::ToolExecutionResult,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        session
            .append_message(Message::tool_result(
                tool_call.id.clone(),
                result.output,
                result.is_error,
            ))
            .await?;
        Ok(())
    }

    async fn record_tool_call_error(
        &self,
        tool_call: &ToolCall,
        error: String,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        self.event_bus.emit(&SparkyEvent::ToolExecutionStart {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: tool_call.arguments.clone(),
        });
        self.event_bus.emit(&SparkyEvent::ToolExecutionEnd {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            output: error.clone(),
            is_error: true,
        });
        session
            .append_message(Message::tool_result(tool_call.id.clone(), error, true))
            .await?;
        Ok(())
    }
}
