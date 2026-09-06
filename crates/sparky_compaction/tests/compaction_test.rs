use async_trait::async_trait;
use sparky_ai::{AssistantMessageEvent, CompletionOptions, EventStream, LlmProvider, Message};
use sparky_compaction::CompactionEngine;
use sparky_session::SessionManager;
use std::sync::Arc;
use std::time::Duration;

struct SummaryProvider;

struct HangingSummaryProvider;

#[async_trait]
impl LlmProvider for SummaryProvider {
    fn provider_name(&self) -> &str {
        "test"
    }

    async fn complete(
        &self,
        _messages: &[Message],
        _options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        Ok(Message::assistant("old work summarized", None))
    }

    async fn stream(
        &self,
        _messages: &[Message],
        _options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        Ok(Box::pin(tokio_stream::iter(vec![
            AssistantMessageEvent::TextDelta("old work summarized".into()),
            AssistantMessageEvent::Done { usage: None },
        ])))
    }
}

#[async_trait]
impl LlmProvider for HangingSummaryProvider {
    fn provider_name(&self) -> &str {
        "hanging-test"
    }

    async fn complete(
        &self,
        _messages: &[Message],
        _options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        anyhow::bail!("the compaction test must use the streaming contract")
    }

    async fn stream(
        &self,
        _messages: &[Message],
        _options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        std::future::pending::<anyhow::Result<EventStream>>().await
    }
}

#[tokio::test]
async fn compaction_replaces_old_prefix_with_summary_and_keeps_recent_message() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    for index in 0..4 {
        session
            .append_message(Message::user(format!(
                "message-{index}:{}",
                "x".repeat(100_000)
            )))
            .await
            .unwrap();
    }

    let compacted = CompactionEngine::new(0.0)
        .compact(&mut session, Arc::new(SummaryProvider), "test-model", 1)
        .await
        .unwrap();

    assert!(compacted);
    assert_eq!(session.entry_count(), 2);
    let context = session.build_context_messages();
    assert_eq!(context.len(), 2);
    assert_eq!(
        context[0].text(),
        "[Compaction Summary]: old work summarized"
    );
    assert!(context[1].text().starts_with("message-3:"));
}

#[tokio::test]
async fn repeated_compaction_keeps_a_bounded_same_session_tail() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    let provider = Arc::new(SummaryProvider);

    for index in 0..8 {
        session
            .append_message(Message::user(format!(
                "message-{index}:{}",
                "x".repeat(8_000)
            )))
            .await
            .unwrap();
    }

    let engine = CompactionEngine::new(0.0);
    assert!(engine
        .compact(&mut session, provider.clone(), "test-model", 1)
        .await
        .unwrap());

    for index in 8..12 {
        session
            .append_message(Message::user(format!(
                "message-{index}:{}",
                "y".repeat(8_000)
            )))
            .await
            .unwrap();
    }

    assert!(engine
        .compact(&mut session, provider, "test-model", 1)
        .await
        .unwrap());

    let context = session.build_context_messages();
    assert_eq!(context.len(), 2);
    assert!(context[0].text().contains("old work summarized"));
    assert!(context[1].text().starts_with("message-11:"));
    assert!(session.entry_count() <= 3);
}

#[tokio::test]
async fn compaction_times_out_without_writing_a_partial_summary() {
    let dir = tempfile::tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    for index in 0..4 {
        session
            .append_message(Message::user(format!(
                "message-{index}:{}",
                "x".repeat(1_000)
            )))
            .await
            .unwrap();
    }

    let engine = CompactionEngine::new_with_timeout(0.0, Duration::from_millis(10));
    let operation = engine.compact(
        &mut session,
        Arc::new(HangingSummaryProvider),
        "test-model",
        1,
    );
    let error = tokio::time::timeout(Duration::from_secs(1), operation)
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.to_string().contains("timed out"));
    assert_eq!(session.entry_count(), 4);
}
