use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
    Custom(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Opaque provider state that must be replayed to continue a stateless
    /// reasoning conversation. It is persisted but never rendered to users.
    ProviderState {
        provider: String,
        data: serde_json::Value,
    },
    Image {
        data: String,
        mime_type: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolResult {
    pub tool_call_id: String,
    pub output: String,
    #[serde(default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentPart>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<ToolResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self::user_with_content(vec![ContentPart::Text { text: text.into() }])
    }

    pub fn user_with_content(content: Vec<ContentPart>) -> Self {
        Self {
            role: Role::User,
            content,
            tool_calls: None,
            tool_result: None,
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
            provider: None,
            model: None,
        }
    }

    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: vec![ContentPart::Text { text: text.into() }],
            tool_calls: None,
            tool_result: None,
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
            provider: None,
            model: None,
        }
    }

    pub fn assistant(text: impl Into<String>, tool_calls: Option<Vec<ToolCall>>) -> Self {
        let mut content = Vec::new();
        let t = text.into();
        if !t.is_empty() {
            content.push(ContentPart::Text { text: t });
        }
        Self {
            role: Role::Assistant,
            content,
            tool_calls,
            tool_result: None,
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
            provider: None,
            model: None,
        }
    }

    pub fn tool_result(
        tool_call_id: impl Into<String>,
        output: impl Into<String>,
        is_error: bool,
    ) -> Self {
        let id_str = tool_call_id.into();
        let out_str = output.into();
        Self {
            role: Role::Tool,
            // Keep the structured result as the single source of truth. The
            // old representation stored the same tool output in both fields,
            // doubling session size and compaction work.
            content: Vec::new(),
            tool_calls: None,
            tool_result: Some(ToolResult {
                tool_call_id: id_str,
                output: out_str,
                is_error,
            }),
            timestamp: Some(chrono::Utc::now().timestamp_millis()),
            provider: None,
            model: None,
        }
    }

    pub fn text(&self) -> String {
        if self.content.is_empty() {
            if let Some(result) = &self.tool_result {
                return result.output.clone();
            }
        }
        let mut parts = Vec::new();
        for part in &self.content {
            if let ContentPart::Text { text } = part {
                parts.push(text.as_str());
            }
        }
        parts.join("\n")
    }

    /// Conservative local estimate used before sending a request. This is
    /// intentionally more complete than `text()`: images and tool-call JSON
    /// also consume provider context even when they have no text rendering.
    pub fn estimated_tokens(&self) -> usize {
        let mut characters = 0usize;
        for part in &self.content {
            match part {
                ContentPart::Text { text } | ContentPart::Thinking { thinking: text, .. } => {
                    characters = characters.saturating_add(text.len());
                }
                ContentPart::Image { data, .. } => {
                    characters = characters.saturating_add(data.len());
                    characters = characters.saturating_add(1_024);
                }
                ContentPart::ProviderState { data, .. } => {
                    characters = characters.saturating_add(data.to_string().len());
                }
            }
        }
        if self.content.is_empty() {
            if let Some(result) = &self.tool_result {
                characters = characters.saturating_add(result.output.len());
            }
        }
        for call in self.tool_calls.as_deref().unwrap_or_default() {
            characters = characters
                .saturating_add(call.id.len())
                .saturating_add(call.name.len())
                .saturating_add(call.arguments.to_string().len());
        }
        characters.div_ceil(4).max(1)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolParamSchema {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageStats {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Low,
    Medium,
    High,
}

impl Default for ThinkingLevel {
    fn default() -> Self {
        ThinkingLevel::Off
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AssistantMessageEvent {
    TextDelta(String),
    ThinkingDelta(String),
    ToolCallDelta {
        id: String,
        name: String,
        arguments_delta: String,
    },
    ProviderState(ContentPart),
    Done {
        usage: Option<UsageStats>,
    },
    Error(String),
}
