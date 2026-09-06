use crate::tool::{Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use serde_json::json;
use sparky_memory::{MemoryScope, MemoryStore};
use std::sync::Arc;
use tokio::sync::Mutex;

pub const MEMORY_SEARCH_TOOL_NAME: &str = "memory_search";
pub const MEMORY_ADD_TOOL_NAME: &str = "memory_add";
pub const MEMORY_UPDATE_TOOL_NAME: &str = "memory_update";
pub const MEMORY_DELETE_TOOL_NAME: &str = "memory_delete";
const MAX_MEMORY_SEARCH_OUTPUT_BYTES: usize = 12_000;
const MAX_MEMORY_SEARCH_CONTENT_CHARS: usize = 1_200;

pub type SharedMemoryStore = Arc<Mutex<MemoryStore>>;

pub struct MemoryTool {
    name: &'static str,
    store: SharedMemoryStore,
}

impl MemoryTool {
    pub fn search(store: SharedMemoryStore) -> Self {
        Self {
            name: MEMORY_SEARCH_TOOL_NAME,
            store,
        }
    }
    pub fn add(store: SharedMemoryStore) -> Self {
        Self {
            name: MEMORY_ADD_TOOL_NAME,
            store,
        }
    }
    pub fn update(store: SharedMemoryStore) -> Self {
        Self {
            name: MEMORY_UPDATE_TOOL_NAME,
            store,
        }
    }
    pub fn delete(store: SharedMemoryStore) -> Self {
        Self {
            name: MEMORY_DELETE_TOOL_NAME,
            store,
        }
    }
}

#[async_trait]
impl Tool for MemoryTool {
    fn name(&self) -> &str {
        self.name
    }
    fn label(&self) -> &str {
        "Memory"
    }
    fn description(&self) -> &str {
        match self.name {
            MEMORY_SEARCH_TOOL_NAME => "Search Sparky's user-approved project and global memories. Use this when a remembered preference or decision may be relevant.",
            MEMORY_ADD_TOOL_NAME => "Save an explicit user-approved fact, preference, convention, or decision to Sparky Memory. Never save secrets or credentials.",
            MEMORY_UPDATE_TOOL_NAME => "Update an existing Sparky Memory entry after confirming the change is wanted. Never save secrets or credentials.",
            MEMORY_DELETE_TOOL_NAME => "Delete an existing Sparky Memory entry when the user asks to forget it.",
            _ => "Manage Sparky Memory.",
        }
    }
    fn parameters(&self) -> serde_json::Value {
        match self.name {
            MEMORY_SEARCH_TOOL_NAME => {
                json!({"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer","minimum":1,"maximum":20}},"required":["query"]})
            }
            MEMORY_ADD_TOOL_NAME => {
                json!({"type":"object","properties":{"scope":{"type":"string","enum":["global","project"]},"title":{"type":"string"},"content":{"type":"string"},"category":{"type":"string"},"importance":{"type":"integer","minimum":1,"maximum":5}},"required":["scope","title","content"]})
            }
            MEMORY_UPDATE_TOOL_NAME => {
                json!({"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"content":{"type":"string"},"category":{"type":"string"},"importance":{"type":"integer","minimum":1,"maximum":5}},"required":["id","title","content"]})
            }
            MEMORY_DELETE_TOOL_NAME => {
                json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]})
            }
            _ => json!({"type":"object"}),
        }
    }
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }
    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let mut store = self.store.lock().await;
        match self.name {
            MEMORY_SEARCH_TOOL_NAME => {
                let query = args
                    .get("query")
                    .and_then(|value| value.as_str())
                    .unwrap_or_default();
                let limit = args
                    .get("limit")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(8)
                    .clamp(1, 20) as usize;
                let memories = store.search(query, limit);
                Ok(ToolExecutionResult::success(if memories.is_empty() {
                    "No matching memories found.".into()
                } else {
                    bounded_search_output(&memories)?
                }))
            }
            MEMORY_ADD_TOOL_NAME => {
                let scope = parse_scope(args.get("scope").and_then(|value| value.as_str()))?;
                let title = required_string(&args, "title")?;
                let content = required_string(&args, "content")?;
                let category = args
                    .get("category")
                    .and_then(|value| value.as_str())
                    .unwrap_or("general")
                    .to_string();
                let importance = args
                    .get("importance")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(3) as u8;
                let memory = store
                    .add(
                        scope,
                        title,
                        content,
                        category,
                        importance,
                        Some("agent".into()),
                    )
                    .await?;
                Ok(ToolExecutionResult::success(format!(
                    "Saved memory '{}' ({}).",
                    memory.title, memory.id
                )))
            }
            MEMORY_UPDATE_TOOL_NAME => {
                let id = required_string(&args, "id")?;
                let existing = store
                    .all()
                    .iter()
                    .find(|memory| memory.id == id)
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("Memory '{}' was not found", id))?;
                let memory = sparky_memory::Memory {
                    id: id.clone(),
                    scope: existing.scope,
                    title: required_string(&args, "title")?,
                    content: required_string(&args, "content")?,
                    category: args
                        .get("category")
                        .and_then(|value| value.as_str())
                        .unwrap_or(&existing.category)
                        .to_string(),
                    importance: args
                        .get("importance")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(existing.importance as u64)
                        as u8,
                    created_at: existing.created_at,
                    updated_at: existing.updated_at,
                    source: existing.source,
                };
                store.upsert(memory).await?;
                Ok(ToolExecutionResult::success(format!(
                    "Updated memory '{}'.",
                    id
                )))
            }
            MEMORY_DELETE_TOOL_NAME => {
                let id = required_string(&args, "id")?;
                let deleted = store.delete(&id).await?;
                Ok(ToolExecutionResult::success(if deleted {
                    format!("Deleted memory '{}'.", id)
                } else {
                    format!("Memory '{}' was not found.", id)
                }))
            }
            _ => Ok(ToolExecutionResult::error("Unknown memory tool")),
        }
    }
}

fn required_string(args: &serde_json::Value, key: &str) -> anyhow::Result<String> {
    args.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow::anyhow!("Missing '{}' parameter", key))
}

fn parse_scope(value: Option<&str>) -> anyhow::Result<MemoryScope> {
    match value.unwrap_or("project") {
        "global" => Ok(MemoryScope::Global),
        "project" => Ok(MemoryScope::Project),
        _ => Err(anyhow::anyhow!(
            "Memory scope must be 'global' or 'project'"
        )),
    }
}

fn bounded_search_output(memories: &[sparky_memory::Memory]) -> anyhow::Result<String> {
    let mut summaries = Vec::new();
    for memory in memories {
        let mut content: String = memory
            .content
            .chars()
            .take(MAX_MEMORY_SEARCH_CONTENT_CHARS)
            .collect();
        if memory.content.chars().count() > MAX_MEMORY_SEARCH_CONTENT_CHARS {
            content.push_str("… [content truncated]");
        }
        let summary = json!({
            "id": memory.id,
            "scope": memory.scope,
            "title": memory.title,
            "content": content,
            "category": memory.category,
            "importance": memory.importance,
        });
        let mut candidate = summaries.clone();
        candidate.push(summary);
        let serialized = serde_json::to_string_pretty(&candidate)?;
        if serialized.len() > MAX_MEMORY_SEARCH_OUTPUT_BYTES {
            break;
        }
        summaries = candidate;
    }
    serde_json::to_string_pretty(&summaries).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_search_results_and_content() {
        let memory = sparky_memory::Memory {
            id: "memory-1".into(),
            scope: MemoryScope::Project,
            title: "Large memory".into(),
            content: "x".repeat(sparky_memory::MAX_MEMORY_CONTENT_CHARS),
            category: "test".into(),
            importance: 3,
            created_at: "now".into(),
            updated_at: "now".into(),
            source: None,
        };
        let output = bounded_search_output(&[memory]).unwrap();
        assert!(output.len() <= MAX_MEMORY_SEARCH_OUTPUT_BYTES);
        assert!(output.contains("content truncated"));
    }
}
