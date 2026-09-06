use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SparkyEvent {
    SessionStart {
        reason: String,
    },
    SessionShutdown {
        reason: String,
    },
    BeforeAgentStart {
        prompt: String,
        system_prompt: String,
    },
    AgentStart,
    AgentEnd,
    TurnStart {
        turn_index: usize,
    },
    TurnEnd {
        turn_index: usize,
    },
    UsageUpdate {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
        cumulative_total_tokens: u64,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
    ModelSelect {
        model: String,
        provider: String,
    },
    UserBash {
        command: String,
    },
}
