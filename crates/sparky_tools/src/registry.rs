use crate::bash::BashTool;
use crate::edit::EditTool;
use crate::find::FindTool;
use crate::grep::GrepTool;
use crate::ls::LsTool;
use crate::memory::{MemoryTool, SharedMemoryStore, MEMORY_SEARCH_TOOL_NAME};
use crate::plan::{AskUserTool, EndTaskTool, UpdatePlanTool, END_TASK_TOOL_NAME};
use crate::read::ReadTool;
use crate::tool::Tool;
use crate::web_search::WebSearchTool;
use crate::write::WriteTool;
use sparky_ai::ToolParamSchema;
use sparky_config::ToolOutputLimits;
use std::collections::HashMap;
use std::sync::Arc;

pub fn is_hidden_control_tool(name: &str) -> bool {
    name == END_TASK_TOOL_NAME
}

#[derive(Default, Clone)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    plan_tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    const PLAN_ONLY_TOOL_NAMES: [&'static str; 1] = ["update_plan"];
    const PLAN_TOOL_NAMES: [&'static str; 9] = [
        "read",
        "ls",
        "grep",
        "find",
        "web_search",
        MEMORY_SEARCH_TOOL_NAME,
        "ask_user",
        "update_plan",
        END_TASK_TOOL_NAME,
    ];

    pub fn new() -> Self {
        Self::with_output_limits(ToolOutputLimits::default())
    }

    pub fn with_memory_store(limits: ToolOutputLimits, store: SharedMemoryStore) -> Self {
        let mut reg = Self::with_output_limits(limits);
        reg.register_builtin(Arc::new(MemoryTool::search(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::add(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::update(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::delete(store)));
        reg
    }

    pub fn with_project_free(_limits: ToolOutputLimits) -> Self {
        let mut reg = Self::default();
        reg.register_builtin(Arc::new(WebSearchTool));
        reg.register_builtin(Arc::new(AskUserTool));
        reg.register_builtin(Arc::new(UpdatePlanTool));
        reg.register_builtin(Arc::new(EndTaskTool));
        reg
    }

    pub fn with_output_limits(limits: ToolOutputLimits) -> Self {
        let mut reg = Self::default();
        reg.register_builtin(Arc::new(ReadTool::new(limits.read_bytes)));
        reg.register_builtin(Arc::new(WriteTool));
        reg.register_builtin(Arc::new(EditTool));
        reg.register_builtin(Arc::new(BashTool::new(limits.bash_bytes)));
        reg.register_builtin(Arc::new(LsTool));
        reg.register_builtin(Arc::new(GrepTool));
        reg.register_builtin(Arc::new(WebSearchTool));
        reg.register_builtin(Arc::new(FindTool));
        reg.register_builtin(Arc::new(AskUserTool));
        reg.register_builtin(Arc::new(UpdatePlanTool));
        reg.register_builtin(Arc::new(EndTaskTool));
        reg
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    fn register_builtin(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        self.tools.insert(name.clone(), tool.clone());
        if Self::PLAN_TOOL_NAMES.contains(&name.as_str()) {
            self.plan_tools.insert(name, tool);
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn get_for_mode(&self, name: &str, plan_mode: bool) -> Option<Arc<dyn Tool>> {
        if plan_mode && !Self::PLAN_TOOL_NAMES.contains(&name) {
            return None;
        }
        if !plan_mode && Self::PLAN_ONLY_TOOL_NAMES.contains(&name) {
            return None;
        }
        if plan_mode {
            return self.plan_tools.get(name).cloned();
        }
        self.get(name)
    }

    pub fn get_schemas(&self) -> Vec<ToolParamSchema> {
        self.tools
            .values()
            .map(|tool| ToolParamSchema {
                name: tool.name().to_string(),
                description: tool.description().to_string(),
                parameters: tool.parameters(),
            })
            .collect()
    }

    pub fn get_schemas_for_mode(&self, plan_mode: bool) -> Vec<ToolParamSchema> {
        if plan_mode {
            return self.schemas_for_names(Self::PLAN_TOOL_NAMES.iter().copied(), &self.plan_tools);
        }
        self.schemas_for_names(
            self.tools
                .keys()
                .map(String::as_str)
                .filter(|name| !Self::PLAN_ONLY_TOOL_NAMES.contains(name)),
            &self.tools,
        )
    }

    fn schemas_for_names<'a, I>(
        &self,
        names: I,
        tools: &HashMap<String, Arc<dyn Tool>>,
    ) -> Vec<ToolParamSchema>
    where
        I: IntoIterator<Item = &'a str>,
    {
        names
            .into_iter()
            .filter_map(|name| tools.get(name))
            .map(|t| ToolParamSchema {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_free_registry_excludes_workspace_tools() {
        let registry = ToolRegistry::with_project_free(ToolOutputLimits::default());

        for name in ["read", "write", "edit", "bash", "ls", "grep", "find"] {
            assert!(
                registry.get(name).is_none(),
                "unexpected project tool: {name}"
            );
        }
        for name in ["web_search", "ask_user", "update_plan", END_TASK_TOOL_NAME] {
            assert!(
                registry.get(name).is_some(),
                "missing project-free tool: {name}"
            );
        }
    }

    #[test]
    fn plan_mode_exposes_only_read_context_and_planning_tools() {
        let registry = ToolRegistry::new();
        let names = registry
            .get_schemas_for_mode(true)
            .into_iter()
            .map(|schema| schema.name)
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "read",
                "ls",
                "grep",
                "find",
                "web_search",
                "ask_user",
                "update_plan",
                "end_task",
            ]
        );
        assert!(registry.get_for_mode("read", true).is_some());
        assert!(registry.get_for_mode("write", true).is_none());
        assert!(registry.get_for_mode("write", false).is_some());
        assert!(registry.get_for_mode("update_plan", true).is_some());
        assert!(registry.get_for_mode("update_plan", false).is_none());
        assert!(!registry
            .get_schemas_for_mode(false)
            .iter()
            .any(|schema| schema.name == "update_plan"));
    }

    #[test]
    fn build_mode_does_not_expose_plan_only_tools_to_the_model() {
        let registry = ToolRegistry::new();

        assert!(registry.get("update_plan").is_some());
        assert!(registry.get_for_mode("update_plan", false).is_none());
    }

    #[tokio::test]
    async fn memory_search_is_available_in_build_and_plan_modes() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(tokio::sync::Mutex::new(
            sparky_memory::MemoryStore::load(dir.path().to_str().unwrap(), None)
                .await
                .unwrap(),
        ));
        let registry = ToolRegistry::with_memory_store(ToolOutputLimits::default(), store);

        assert!(registry
            .get_for_mode(MEMORY_SEARCH_TOOL_NAME, true)
            .is_some());
        assert!(registry
            .get_for_mode(MEMORY_SEARCH_TOOL_NAME, false)
            .is_some());
        assert!(registry.get_for_mode("memory_add", true).is_none());
        assert!(registry.get_for_mode("memory_add", false).is_some());
    }
}
