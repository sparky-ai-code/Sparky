use async_trait::async_trait;
use serde_json::json;
use sparky_ai::LlmProvider;
use sparky_extensions::{EventBus, SparkyEvent};
use sparky_session::SessionManager;
use sparky_tools::{Tool, ToolExecutionResult, ToolRegistry};
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::loop_runner::{AgentLoop, AgentLoopOptions};

pub type SharedSubagentInbox = Arc<Mutex<VecDeque<String>>>;

pub struct MessageTeamTool {
    inbox: SharedSubagentInbox,
    sender: String,
}

impl MessageTeamTool {
    pub fn new(inbox: SharedSubagentInbox, sender: impl Into<String>) -> Self {
        Self { inbox, sender: sender.into() }
    }
}

#[async_trait]
impl Tool for MessageTeamTool {
    fn name(&self) -> &str { "message_team" }
    fn label(&self) -> &str { "Message the agent team" }
    fn description(&self) -> &str {
        "Send a concise update to the shared subagent team inbox, or read messages other agents have left for you. Use action=send with message, or action=read."
    }
    fn parameters(&self) -> serde_json::Value {
        json!({"type":"object","properties":{
            "action":{"type":"string","enum":["send","read"]},
            "message":{"type":"string","description":"Message to share with the team (required for send)."}
        },"required":["action"],"additionalProperties":false})
    }
    async fn execute(&self, args: serde_json::Value, _cwd: &str) -> anyhow::Result<ToolExecutionResult> {
        match args.get("action").and_then(|value| value.as_str()) {
            Some("send") => {
                let message = args.get("message").and_then(|value| value.as_str()).unwrap_or_default().trim();
                if message.is_empty() || message.len() > 4_000 {
                    return Ok(ToolExecutionResult::error("Provide a message between 1 and 4000 characters."));
                }
                let mut inbox = self.inbox.lock().await;
                if inbox.len() >= 256 { inbox.pop_front(); }
                inbox.push_back(format!("{}: {}", self.sender, message));
                Ok(ToolExecutionResult::success("Message delivered to the shared agent inbox."))
            }
            Some("read") => {
                let inbox = self.inbox.lock().await;
                if inbox.is_empty() { return Ok(ToolExecutionResult::success("No team messages yet.")); }
                Ok(ToolExecutionResult::success(inbox.iter().cloned().collect::<Vec<_>>().join("\n")))
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
}

impl SpawnSubagentTool {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tools: ToolRegistry,
        events: EventBus,
        parent_options: AgentLoopOptions,
        inbox: SharedSubagentInbox,
    ) -> Self {
        Self { provider, tools, events, parent_options, inbox }
    }
}

#[async_trait]
impl Tool for SpawnSubagentTool {
    fn name(&self) -> &str { "spawn_subagent" }
    fn label(&self) -> &str { "Spawn subagent" }
    fn description(&self) -> &str {
        "Delegate a focused task to a child Sparky agent. Choose its model and optional reasoning effort; the child shares the current workspace and provider runtime."
    }
    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "task": { "type": "string", "description": "A self-contained task for the child agent." },
                "name": { "type": "string", "description": "Short display name for this subagent." },
                "model": { "type": "string", "description": "Model identifier for the child agent." },
                "reasoning_effort": { "type": "string", "enum": ["low", "medium", "high"] }
            },
            "required": ["task", "model"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, args: serde_json::Value, _cwd: &str) -> anyhow::Result<ToolExecutionResult> {
        let task = args.get("task").and_then(|v| v.as_str()).unwrap_or_default().trim();
        let model = args.get("model").and_then(|v| v.as_str()).unwrap_or_default().trim();
        if task.is_empty() || model.is_empty() {
            return Ok(ToolExecutionResult::error("Both task and model are required."));
        }
        if task.len() > 32_000 || model.len() > 256 {
            return Ok(ToolExecutionResult::error("Task or model identifier exceeds the supported limit."));
        }
        let name = args.get("name").and_then(|v| v.as_str()).unwrap_or("Subagent").trim();
        let name = if name.is_empty() { "Subagent" } else { name };
        let name = name.chars().take(64).collect::<String>();
        let effort = args.get("reasoning_effort").and_then(|v| v.as_str());
        if effort.is_some_and(|value| !["low", "medium", "high"].contains(&value)) {
            return Ok(ToolExecutionResult::error("reasoning_effort must be low, medium, or high."));
        }

        let mut options = self.parent_options.clone();
        options.model_name = model.to_owned();
        if effort.is_some() { options.reasoning_effort = effort.map(str::to_owned); }
        self.events.emit(&SparkyEvent::SubagentStarted {
            name: name.clone(), model: model.to_owned(), provider: self.provider.provider_name().to_owned(),
        });
        self.events.emit(&SparkyEvent::ModelSelect {
            model: options.model_name.clone(), provider: self.provider.provider_name().to_owned(),
        });
        let result = async {
            let mut session = SessionManager::create_new(&options.cwd, None).await?;
            let mut child_tools = self.tools.clone();
            child_tools.register(Arc::new(MessageTeamTool::new(self.inbox.clone(), name.clone())));
            let child = AgentLoop::new(self.provider.clone(), child_tools, self.events.clone(), options);
            child.run_turn(task, &mut session).await
        }.await;
        self.events.emit(&SparkyEvent::SubagentFinished {
            name: name.clone(), model: model.to_owned(), is_error: result.is_err(),
        });
        self.events.emit(&SparkyEvent::ModelSelect {
            model: self.parent_options.model_name.clone(), provider: self.provider.provider_name().to_owned(),
        });
        match result {
            Ok(output) => Ok(ToolExecutionResult::success(format!("{name} ({model}) completed:\\n{output}"))),
            Err(error) => Ok(ToolExecutionResult::error(format!("{name} failed: {error:#}"))),
        }
    }
}
