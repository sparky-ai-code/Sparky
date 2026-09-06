use crate::events::SparkyEvent;
use async_trait::async_trait;
use boa_engine::{Context, Source};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sparky_tools::{Tool, ToolExecutionMode, ToolExecutionResult, ToolRegistry};
use std::path::Path;
use std::sync::{mpsc, Arc};
use tokio::fs;
use tokio::sync::oneshot;

const BOOTSTRAP: &str = r#"
(() => {
  const tools = new Map();
  const listeners = [];
  const state = Object.create(null);

  globalThis.sparky = Object.freeze({
    registerTool(definition) {
      if (!definition || typeof definition.name !== "string" || !definition.name) {
        throw new TypeError("sparky.registerTool requires a non-empty name");
      }
      if (typeof definition.execute !== "function") {
        throw new TypeError("sparky.registerTool requires an execute function");
      }
      tools.set(definition.name, {
        name: definition.name,
        label: definition.label || definition.name,
        description: definition.description || "JavaScript extension tool",
        parameters: definition.parameters || { type: "object", properties: {} },
        execute: definition.execute,
      });
    },
    on(eventType, handler) {
      if (typeof handler !== "function") throw new TypeError("event handler must be a function");
      listeners.push({ eventType, handler });
    },
    getState(key) { return state[key]; },
    setState(key, value) { state[key] = value; return value; },
  });

  globalThis.__sparkyDispatchEvent = event => {
    for (const listener of listeners) {
      if (listener.eventType === "*" || listener.eventType === event.type) {
        listener.handler(event);
      }
    }
    if (typeof globalThis.onSparkyEvent === "function") {
      globalThis.onSparkyEvent(event);
    }
  };

  globalThis.__sparkyToolDefinitions = () => JSON.stringify(
    Array.from(tools.values(), ({ execute, ...definition }) => definition)
  );

  globalThis.__sparkyInvokeTool = (name, args, cwd) => {
    const definition = tools.get(name);
    if (!definition) throw new Error(`Unknown JavaScript extension tool: ${name}`);
    const result = definition.execute(args, { cwd, state: globalThis.sparky });
    const normalized = typeof result === "string"
      ? { output: result, is_error: false }
      : {
          output: String(result?.output ?? result ?? ""),
          is_error: Boolean(result?.is_error ?? result?.isError ?? false),
        };
    return JSON.stringify(normalized);
  };

  globalThis.__sparkyReadState = () => JSON.stringify(state);
})();
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsToolDefinition {
    pub name: String,
    pub label: String,
    pub description: String,
    pub parameters: Value,
}

enum Command {
    Load {
        source: String,
        path: String,
        response: oneshot::Sender<Result<(), String>>,
    },
    Emit {
        event_json: String,
        response: Option<oneshot::Sender<Result<(), String>>>,
    },
    ListTools {
        response: oneshot::Sender<Result<Vec<JsToolDefinition>, String>>,
    },
    ExecuteTool {
        name: String,
        args: Value,
        cwd: String,
        response: oneshot::Sender<Result<ToolExecutionResult, String>>,
    },
    ReadState {
        response: oneshot::Sender<Result<Value, String>>,
    },
}

#[derive(Clone)]
pub struct JsExtensionRunner {
    commands: mpsc::Sender<Command>,
}

impl Default for JsExtensionRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl JsExtensionRunner {
    pub fn new() -> Self {
        let (commands, receiver) = mpsc::channel();
        std::thread::Builder::new()
            .name("sparky-js-extension".to_string())
            .spawn(move || run_js_worker(receiver))
            .expect("failed to start JavaScript extension worker");
        Self { commands }
    }

    pub async fn load_extension_file(&self, path: &Path) -> anyhow::Result<()> {
        let source = fs::read_to_string(path).await?;
        let (response, result) = oneshot::channel();
        self.commands
            .send(Command::Load {
                source,
                path: path.display().to_string(),
                response,
            })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?;
        result
            .await
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?
            .map_err(anyhow::Error::msg)?;
        Ok(())
    }

    pub async fn emit_event(&self, event: &SparkyEvent) -> anyhow::Result<()> {
        let event_json = serde_json::to_string(event)?;
        let (response, result) = oneshot::channel();
        self.commands
            .send(Command::Emit {
                event_json,
                response: Some(response),
            })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?;
        result
            .await
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?
            .map_err(anyhow::Error::msg)?;
        Ok(())
    }

    pub fn emit_event_nowait(&self, event: &SparkyEvent) -> anyhow::Result<()> {
        self.commands
            .send(Command::Emit {
                event_json: serde_json::to_string(event)?,
                response: None,
            })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))
    }

    pub async fn registered_tools(&self) -> anyhow::Result<Vec<JsToolDefinition>> {
        let (response, result) = oneshot::channel();
        self.commands
            .send(Command::ListTools { response })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?;
        Ok(result
            .await
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?
            .map_err(anyhow::Error::msg)?)
    }

    pub async fn register_tools(&self, registry: &mut ToolRegistry) -> anyhow::Result<usize> {
        let definitions = self.registered_tools().await?;
        for definition in &definitions {
            registry.register(Arc::new(JsExtensionTool {
                runner: self.clone(),
                definition: definition.clone(),
            }));
        }
        Ok(definitions.len())
    }

    pub async fn read_state(&self) -> anyhow::Result<Value> {
        let (response, result) = oneshot::channel();
        self.commands
            .send(Command::ReadState { response })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?;
        Ok(result
            .await
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?
            .map_err(anyhow::Error::msg)?)
    }

    async fn execute_tool(
        &self,
        name: &str,
        args: Value,
        cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let (response, result) = oneshot::channel();
        self.commands
            .send(Command::ExecuteTool {
                name: name.to_string(),
                args,
                cwd: cwd.to_string(),
                response,
            })
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?;
        Ok(result
            .await
            .map_err(|_| anyhow::anyhow!("JavaScript extension worker stopped"))?
            .map_err(anyhow::Error::msg)?)
    }
}

struct JsExtensionTool {
    runner: JsExtensionRunner,
    definition: JsToolDefinition,
}

#[async_trait]
impl Tool for JsExtensionTool {
    fn name(&self) -> &str {
        &self.definition.name
    }

    fn label(&self) -> &str {
        &self.definition.label
    }

    fn description(&self) -> &str {
        &self.definition.description
    }

    fn parameters(&self) -> Value {
        self.definition.parameters.clone()
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    async fn execute(&self, args: Value, cwd: &str) -> anyhow::Result<ToolExecutionResult> {
        self.runner.execute_tool(self.name(), args, cwd).await
    }
}

fn run_js_worker(receiver: mpsc::Receiver<Command>) {
    let mut context = Context::default();
    if let Err(error) = context.eval(Source::from_bytes(BOOTSTRAP)) {
        tracing::error!("Failed to initialize JavaScript extension API: {error}");
        return;
    }

    while let Ok(command) = receiver.recv() {
        match command {
            Command::Load {
                source,
                path,
                response,
            } => {
                let result = context
                    .eval(Source::from_bytes(source.as_bytes()))
                    .map(|value| {
                        tracing::info!("Loaded JS extension {path}: {:?}", value.display());
                    })
                    .map_err(|error| format!("Failed to execute JS extension {path}: {error}"));
                let _ = response.send(result);
            }
            Command::Emit {
                event_json,
                response,
            } => {
                let result = context
                    .eval(Source::from_bytes(
                        format!("globalThis.__sparkyDispatchEvent({event_json});").as_bytes(),
                    ))
                    .map(|_| ())
                    .map_err(|error| format!("JavaScript event handler failed: {error}"));
                if let Some(response) = response {
                    let _ = response.send(result);
                } else if let Err(error) = result {
                    tracing::error!("{error}");
                }
            }
            Command::ListTools { response } => {
                let result = eval_string(&mut context, "globalThis.__sparkyToolDefinitions();")
                    .and_then(|json| {
                        serde_json::from_str(&json).map_err(|error| error.to_string())
                    });
                let _ = response.send(result);
            }
            Command::ExecuteTool {
                name,
                args,
                cwd,
                response,
            } => {
                let expression = format!(
                    "globalThis.__sparkyInvokeTool({}, {}, {});",
                    serde_json::to_string(&name).unwrap_or_default(),
                    args,
                    serde_json::to_string(&cwd).unwrap_or_default(),
                );
                let result = eval_string(&mut context, &expression).and_then(|json| {
                    serde_json::from_str(&json).map_err(|error| error.to_string())
                });
                let _ = response.send(result);
            }
            Command::ReadState { response } => {
                let result =
                    eval_string(&mut context, "globalThis.__sparkyReadState();").and_then(|json| {
                        serde_json::from_str(&json).map_err(|error| error.to_string())
                    });
                let _ = response.send(result);
            }
        }
    }
}

fn eval_string(context: &mut Context, expression: &str) -> Result<String, String> {
    let value = context
        .eval(Source::from_bytes(expression.as_bytes()))
        .map_err(|error| error.to_string())?;
    value
        .to_string(context)
        .map(|string| string.to_std_string_escaped())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn dispatches_events_tracks_state_and_registers_tools() {
        let dir = tempfile::tempdir().unwrap();
        let extension_path = dir.path().join("extension.js");
        fs::write(
            &extension_path,
            r#"
                sparky.setState("turns", 0);
                onSparkyEvent = event => {
                    if (event.type === "turn_start") {
                        sparky.setState("turns", sparky.getState("turns") + 1);
                    }
                };
                sparky.registerTool({
                    name: "echo",
                    label: "Echo",
                    description: "Echo text",
                    parameters: { type: "object", properties: { text: { type: "string" } } },
                    execute(args, context) {
                        return `${args.text}@${context.cwd}`;
                    },
                });
            "#,
        )
        .await
        .unwrap();

        let runner = JsExtensionRunner::new();
        runner.load_extension_file(&extension_path).await.unwrap();
        runner
            .emit_event(&SparkyEvent::TurnStart { turn_index: 1 })
            .await
            .unwrap();
        assert_eq!(runner.read_state().await.unwrap()["turns"], 1);

        let mut registry = ToolRegistry::default();
        assert_eq!(runner.register_tools(&mut registry).await.unwrap(), 1);
        let result = registry
            .get("echo")
            .unwrap()
            .execute(serde_json::json!({ "text": "hello" }), "workspace")
            .await
            .unwrap();
        assert!(!result.is_error);
        assert_eq!(result.output, "hello@workspace");
    }
}
