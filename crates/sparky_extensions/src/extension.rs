use crate::event_bus::EventBus;
use async_trait::async_trait;
use sparky_tools::ToolRegistry;

pub struct ExtensionContext {
    pub cwd: String,
    pub event_bus: EventBus,
    pub tool_registry: ToolRegistry,
}

#[async_trait]
pub trait RustExtension: Send + Sync {
    fn name(&self) -> &str;
    async fn initialize(&self, ctx: &mut ExtensionContext) -> anyhow::Result<()>;
}
