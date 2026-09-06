use sparky_ai::{AssistantMessageEvent, CompletionOptions, LlmProvider, Message};
use sparky_session::{SessionEntry, SessionManager};
use std::sync::Arc;
use std::time::Duration;
use tokio_stream::StreamExt;
use uuid::Uuid;

// Keep enough of the actionable tail (paths, tool results, and current plan)
// to make the post-compaction turn useful. The old 20k cap discarded too much
// context on large-window models.
const KEEP_RECENT_TOKENS: usize = 48_000;
const COMPACTION_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone)]
pub struct ContextUsage {
    pub estimated_tokens: usize,
    pub max_tokens: usize,
    pub percentage: f32,
}

pub struct CompactionEngine {
    threshold_percent: f32,
    timeout: Duration,
}

impl Default for CompactionEngine {
    fn default() -> Self {
        Self {
            threshold_percent: 80.0,
            timeout: COMPACTION_TIMEOUT,
        }
    }
}

impl CompactionEngine {
    pub fn new(threshold_percent: f32) -> Self {
        Self {
            threshold_percent,
            timeout: COMPACTION_TIMEOUT,
        }
    }

    pub fn new_with_timeout(threshold_percent: f32, timeout: Duration) -> Self {
        Self {
            threshold_percent,
            timeout,
        }
    }

    pub fn estimate_tokens(messages: &[Message]) -> usize {
        messages.iter().map(Message::estimated_tokens).sum()
    }

    pub fn calculate_usage(&self, messages: &[Message], max_context_window: usize) -> ContextUsage {
        let estimated = Self::estimate_tokens(messages);
        let pct = if max_context_window > 0 {
            (estimated as f32 / max_context_window as f32) * 100.0
        } else {
            0.0
        };

        ContextUsage {
            estimated_tokens: estimated,
            max_tokens: max_context_window,
            percentage: pct,
        }
    }

    pub fn should_compact(&self, usage: &ContextUsage) -> bool {
        usage.percentage >= self.threshold_percent
    }

    pub async fn compact(
        &self,
        session: &mut SessionManager,
        provider: Arc<dyn LlmProvider>,
        model_name: &str,
        max_context_window: usize,
    ) -> anyhow::Result<bool> {
        self.compact_with_mode(session, provider, model_name, max_context_window, false)
            .await
    }

    /// Force one same-session compaction after a provider reports an overflow.
    /// This is intentionally separate from the proactive threshold path so a
    /// provider with a smaller effective window can still recover reliably.
    pub async fn compact_now(
        &self,
        session: &mut SessionManager,
        provider: Arc<dyn LlmProvider>,
        model_name: &str,
        max_context_window: usize,
    ) -> anyhow::Result<bool> {
        self.compact_with_mode(session, provider, model_name, max_context_window, true)
            .await
    }

    async fn compact_with_mode(
        &self,
        session: &mut SessionManager,
        provider: Arc<dyn LlmProvider>,
        model_name: &str,
        max_context_window: usize,
        force: bool,
    ) -> anyhow::Result<bool> {
        let messages = session.build_context_messages();
        let usage = self.calculate_usage(&messages, max_context_window);

        let minimum_messages = if force { 2 } else { 4 };
        if (!force && !self.should_compact(&usage)) || messages.len() < minimum_messages {
            return Ok(false);
        }

        let keep_recent_tokens = KEEP_RECENT_TOKENS.min((max_context_window / 3).max(1));
        let first_kept_entry_id = session
            .first_entry_id_for_recent_tokens(keep_recent_tokens)
            .ok_or_else(|| anyhow::anyhow!("Cannot compact a session without message entries"))?;

        let history_messages = session.build_compaction_messages(&first_kept_entry_id);
        let history = history_messages
            .iter()
            .map(|message| {
                let role = format!("{:?}", message.role);
                let text = message.text();
                let tool_calls = message
                    .tool_calls
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .map(|call| format!("{}({})", call.name, call.arguments))
                    .collect::<Vec<_>>()
                    .join(", ");
                if tool_calls.is_empty() {
                    format!("[{role}]\n{text}")
                } else {
                    format!("[{role}]\n{text}\nTool calls: {tool_calls}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let prompt = vec![
            Message::system("You are a concise conversation summarizer. Preserve key facts, decisions, file modifications, tool results, unresolved errors, and ongoing goals. Return a structured summary that another coding agent can act on without the original transcript."),
            Message::user(format!("Summarize this conversation context:\n\n{history}")),
        ];

        let options = CompletionOptions {
            model: model_name.to_string(),
            temperature: Some(0.3),
            max_tokens: Some(2048),
            ..Default::default()
        };

        // The ChatGPT Codex endpoint rejects non-streaming requests. Use the
        // provider's streaming contract for summaries too, which also makes
        // compaction work consistently across providers.
        let (summary_text, saw_completion) = tokio::time::timeout(self.timeout, async {
            let mut stream = provider.stream(&prompt, &options).await?;
            let mut summary_text = String::new();
            let mut saw_completion = false;
            while let Some(event) = stream.next().await {
                match event {
                    AssistantMessageEvent::TextDelta(delta) => summary_text.push_str(&delta),
                    AssistantMessageEvent::Error(message) => anyhow::bail!(message),
                    AssistantMessageEvent::ThinkingDelta(_)
                    | AssistantMessageEvent::ProviderState(_)
                    | AssistantMessageEvent::ToolCallDelta { .. } => {}
                    AssistantMessageEvent::Done { .. } => {
                        saw_completion = true;
                        break;
                    }
                }
            }
            anyhow::Result::<(String, bool)>::Ok((summary_text, saw_completion))
        })
        .await
        .map_err(|_| anyhow::anyhow!("Compaction provider timed out after {:?}", self.timeout))??;
        if !saw_completion {
            anyhow::bail!("Compaction provider ended before returning a complete summary")
        }
        if summary_text.trim().is_empty() {
            anyhow::bail!("Compaction provider returned an empty summary")
        }

        let compaction_entry = SessionEntry::Compaction {
            id: Uuid::new_v4().to_string(),
            parent_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            summary: summary_text,
            first_kept_entry_id: first_kept_entry_id.clone(),
            tokens_before: usage.estimated_tokens as u32,
        };

        session.append_entry(compaction_entry).await?;
        session.trim_entries_before(&first_kept_entry_id)?;
        session.rewrite_session_file().await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_usage_from_the_explicit_provider_window() {
        let engine = CompactionEngine::default();
        let usage = engine.calculate_usage(&[Message::user("hello")], 1_000);
        assert_eq!(usage.max_tokens, 1_000);
        assert!(usage.estimated_tokens > 0);
    }
}
