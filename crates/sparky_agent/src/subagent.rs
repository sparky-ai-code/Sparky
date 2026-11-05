use async_trait::async_trait;
use serde_json::json;
use sparky_ai::LlmProvider;
use sparky_extensions::{EventBus, SparkyEvent};
use sparky_session::SessionManager;
use sparky_tools::{Tool, ToolExecutionResult, ToolRegistry};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{Mutex, oneshot};

use crate::loop_runner::{AgentLoop, AgentLoopOptions};

pub type SharedSubagentInbox = Arc<Mutex<VecDeque<String>>>;
pub type SharedSubagentRegistry = Arc<Mutex<HashMap<String, SubagentEntry>>>;

pub struct SubagentEntry {
    name: String,
    cancel: Option<oneshot::Sender<()>>,
}

static NEXT_SUBAGENT_ID: AtomicU64 = AtomicU64::new(1);

fn normalize_subagent_model(provider: &str, model: &str) -> String {
    let model = model.trim();
    let model = model
        .split_once('/')
        .filter(|(prefix, _)| prefix.eq_ignore_ascii_case(provider))
        .map_or(model, |(_, model_id)| model_id.trim());

    if model.chars().any(char::is_whitespace) {
        model
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
            .to_ascii_lowercase()
    } else {
        model.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_subagent_model;

    #[test]
    fn normalizes_provider_qualified_and_display_name_model_ids() {
        assert_eq!(
            normalize_subagent_model("openai-codex", "openai-codex/gpt-6-luna"),
            "gpt-6-luna"
        );
        assert_eq!(
            normalize_subagent_model("openai-codex", "GPT-6 Luna"),
            "gpt-6-luna"
        );
        assert_eq!(
            normalize_subagent_model("openai-codex", "gpt-6-luna"),
            "gpt-6-luna"
        );
    }
}

pub struct MessageTeamTool {
    inbox: SharedSubagentInbox,
    sender: String,
}

impl MessageTeamTool {
    pub fn new(inbox: SharedSubagentInbox, sender: impl Into<String>) -> Self {
        Self {
            inbox,
            sender: sender.into(),
        }
    }
}

#[async_trait]
impl Tool for MessageTeamTool {
    fn name(&self) -> &str {
        "message_team"
    }
    fn label(&self) -> &str {
        "Message the agent team"
    }
    fn description(&self) -> &str {
        "Send a concise update to the shared subagent team inbox, or read messages other agents have left for you. Use action=send with message, or action=read."
    }
    fn parameters(&self) -> serde_json::Value {
        json!({"type":"object","properties":{
            "action":{"type":"string","enum":["send","read"]},
            "message":{"type":"string","description":"Message to share with the team (required for send)."}
        },"required":["action"],"additionalProperties":false})
    }
    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        match args.get("action").and_then(|value| value.as_str()) {
            Some("send") => {
                let message = args
                    .get("message")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default()
                    .trim();
                if message.is_empty() || message.len() > 4_000 {
                    return Ok(ToolExecutionResult::error(
                        "Provide a message between 1 and 4000 characters.",
                    ));
                }
                let mut inbox = self.inbox.lock().await;
                if inbox.len() >= 256 {
                    inbox.pop_front();
                }
                inbox.push_back(format!("{}: {}", self.sender, message));
                Ok(ToolExecutionResult::success(
                    "Message delivered to the shared agent inbox.",
                ))
            }
            Some("read") => {
                let inbox = self.inbox.lock().await;
                if inbox.is_empty() {
                    return Ok(ToolExecutionResult::success("No team messages yet."));
                }
                Ok(ToolExecutionResult::success(
                    inbox.iter().cloned().collect::<Vec<_>>().join("\n"),
                ))
            }
            _ => Ok(ToolExecutionResult::error("action must be send or read.")),
        }
    }
}

/// Runs a bounded child agent in-process, reusing the parent's provider and
/// warmed runtime while allowing the caller to choose its model and effort.
pub struct SpawnSubagentTool {
    provider: Arc<dyn LlmProvider>,
    tools: ToolRegistry,
    events: EventBus,
    parent_options: AgentLoopOptions,
    inbox: SharedSubagentInbox,
    registry: SharedSubagentRegistry,
}

impl SpawnSubagentTool {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tools: ToolRegistry,
        events: EventBus,
        parent_options: AgentLoopOptions,
        inbox: SharedSubagentInbox,
        registry: SharedSubagentRegistry,
    ) -> Self {
        Self {
            provider,
            tools,
            events,
            parent_options,
            inbox,
            registry,
        }
    }
}

#[async_trait]
impl Tool for SpawnSubagentTool {
    fn name(&self) -> &str {
        "spawn_subagent"
    }
    fn label(&self) -> &str {
        "Spawn subagent"
    }
    fn description(&self) -> &str {
        "Delegate a focused task to a child Sparky agent. Choose any model supported by the current provider (use its model ID or display name) and optional reasoning effort; the child shares the current workspace and provider runtime."
    }
    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "A self-contained task for the child agent." },
                "name": { "type": "string", "description": "A concise, specific human-readable name derived from the delegated goal (for example, 'Trace auth flow' or 'Review API tests'). Never use numbered generic labels." },
                "model": { "type": "string", "description": "Model identifier for the child agent." },
                "reasoning_effort": { "type": "string", "enum": ["low", "medium", "high"] }
            },
            "required": ["task", "name", "model"],
            "additionalProperties": false
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let task = args
            .get("task")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        let requested_model = args
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        let name = args
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_owned();
        if task.is_empty() || requested_model.is_empty() || name.is_empty() {
            return Ok(ToolExecutionResult::error(
                "Task, a specific name, and model are required.",
            ));
        }
        let model = normalize_subagent_model(self.provider.provider_name(), &requested_model);
        let normalized_name = name.to_ascii_lowercase();
        let generic_suffix = normalized_name
            .strip_prefix("subagent ")
            .or_else(|| normalized_name.strip_prefix("agent "));
        if normalized_name == "subagent"
            || normalized_name == "agent"
            || generic_suffix.is_some_and(|suffix| {
                !suffix.is_empty() && suffix.chars().all(|character| character.is_ascii_digit())
            })
        {
            return Ok(ToolExecutionResult::error(
                "Choose a descriptive name tied to the task, not a generic numbered agent label.",
            ));
        }
        if task.len() > 32_000 || model.len() > 256 || name.len() > 64 {
            return Ok(ToolExecutionResult::error(
                "Task, name, or model identifier exceeds the supported limit.",
            ));
        }
        let effort = args.get("reasoning_effort").and_then(|v| v.as_str());
        if effort.is_some_and(|value| !["low", "medium", "high"].contains(&value)) {
            return Ok(ToolExecutionResult::error(
                "reasoning_effort must be low, medium, or high.",
            ));
        }

        let id = format!(
            "subagent-{}",
            NEXT_SUBAGENT_ID.fetch_add(1, Ordering::Relaxed)
        );
        let mut options = self.parent_options.clone();
        options.model_name = model.clone();
        if effort.is_some() {
            options.reasoning_effort = effort.map(str::to_owned);
        }
        let (cancel_tx, mut cancel_rx) = oneshot::channel();
        self.registry.lock().await.insert(
            id.clone(),
            SubagentEntry {
                name: name.clone(),
                cancel: Some(cancel_tx),
            },
        );
        let id_for_task = id.clone();
        let name_for_task = name.clone();
        let model_for_task = model.clone();
        let task_for_task = task.clone();
        let provider = self.provider.clone();
        let tools = self.tools.clone();
        let events = self.events.clone();
        let inbox = self.inbox.clone();
        let registry = self.registry.clone();
        let provider_name = self.provider.provider_name().to_owned();

        events.emit(&SparkyEvent::SubagentStarted {
            id: id.clone(),
            name: name.clone(),
            task: task.clone(),
            model: model.clone(),
            provider: provider_name.clone(),
        });
        tokio::spawn(async move {
            let result = async {
                let mut session = SessionManager::create_new(&options.cwd, None).await?;
                let mut child_tools = tools;
                child_tools.register(Arc::new(MessageTeamTool::new(
                    inbox.clone(),
                    name_for_task.clone(),
                )));
                let child = AgentLoop::new(provider, child_tools, events.clone(), options);
                child.run_turn(&task_for_task, &mut session).await
            };
            let (result, is_cancelled) = tokio::select! {
                result = result => (result, false),
                _ = &mut cancel_rx => (Err(anyhow::anyhow!("Stopped by the parent agent.")), true),
            };
            let is_error = result.is_err() && !is_cancelled;
            let result_text = match &result {
                Ok(output) => output.clone(),
                Err(_) if is_cancelled => "Stopped by the parent agent.".to_owned(),
                Err(error) => format!("{error:#}"),
            };
            let mut registry_guard = registry.lock().await;
            if let Some(entry) = registry_guard.get_mut(&id_for_task) {
                entry.cancel = None;
                events.emit(&SparkyEvent::SubagentFinished {
                    id: id_for_task.clone(),
                    name: name_for_task.clone(),
                    task: task_for_task.clone(),
                    model: model_for_task,
                    provider: provider_name,
                    result: result_text.clone(),
                    is_error,
                    is_cancelled,
                });
            } else {
                return;
            }
            drop(registry_guard);
            let _ = inbox
                .lock()
                .await
                .push_back(format!("{}: {}", name_for_task, result_text));
        });
        Ok(ToolExecutionResult::success(format!(
            "Started {name} (ID: {id}, model: {model}). You can continue working; use stop_subagent with this ID to stop it, or clear the team board when finished."
        )))
    }
}

pub struct StopSubagentTool {
    registry: SharedSubagentRegistry,
    events: EventBus,
}

impl StopSubagentTool {
    pub fn new(registry: SharedSubagentRegistry, events: EventBus) -> Self {
        Self { registry, events }
    }
}

#[async_trait]
impl Tool for StopSubagentTool {
    fn name(&self) -> &str {
        "stop_subagent"
    }
    fn label(&self) -> &str {
        "Manage subagents"
    }
    fn description(&self) -> &str {
        "Stop one running subagent, remove one subagent from the board, or stop and clear all subagents. Use IDs returned by spawn_subagent."
    }
    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["stop", "remove", "clear"] },
                "id": { "type": "string", "description": "Subagent ID; required for stop and remove." }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }
    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let id = args.get("id").and_then(|v| v.as_str()).map(str::to_owned);
        match action {
            "stop" => {
                let Some(id) = id else {
                    return Ok(ToolExecutionResult::error("Provide a subagent ID to stop."));
                };
                let mut registry = self.registry.lock().await;
                let Some(entry) = registry.get_mut(&id) else {
                    return Ok(ToolExecutionResult::error(
                        "No subagent with that ID is on the board.",
                    ));
                };
                let Some(cancel) = entry.cancel.take() else {
                    return Ok(ToolExecutionResult::error(format!(
                        "{} has already finished; use action=remove to clear it from the board.",
                        entry.name
                    )));
                };
                let name = entry.name.clone();
                let _ = cancel.send(());
                Ok(ToolExecutionResult::success(format!(
                    "Stopping {name} ({id})."
                )))
            }
            "remove" => {
                let Some(id) = id else {
                    return Ok(ToolExecutionResult::error(
                        "Provide a subagent ID to remove.",
                    ));
                };
                let Some(entry) = self.registry.lock().await.remove(&id) else {
                    return Ok(ToolExecutionResult::error(
                        "No subagent with that ID is on the board.",
                    ));
                };
                if let Some(cancel) = entry.cancel {
                    let _ = cancel.send(());
                }
                self.events
                    .emit(&SparkyEvent::SubagentRemoved { id: id.clone() });
                Ok(ToolExecutionResult::success(format!(
                    "Removed {} ({id}) from the team board.",
                    entry.name
                )))
            }
            "clear" => {
                let entries = std::mem::take(&mut *self.registry.lock().await);
                if entries.is_empty() {
                    return Ok(ToolExecutionResult::success(
                        "The subagent board is already clear.",
                    ));
                }
                for (id, entry) in entries {
                    if let Some(cancel) = entry.cancel {
                        let _ = cancel.send(());
                    }
                    self.events.emit(&SparkyEvent::SubagentRemoved { id });
                }
                Ok(ToolExecutionResult::success(
                    "Stopped active subagents and cleared the team board.",
                ))
            }
            _ => Ok(ToolExecutionResult::error(
                "action must be stop, remove, or clear.",
            )),
        }
    }
}
