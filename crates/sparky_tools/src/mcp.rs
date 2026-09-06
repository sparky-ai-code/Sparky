use crate::{Tool, ToolExecutionResult, ToolRegistry};
use async_trait::async_trait;
use reqwest::header::{ACCEPT, CONTENT_TYPE};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const MAX_ERROR_BODY_CHARS: usize = 4_096;
const MAX_TOOL_OUTPUT_BYTES: usize = sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES;

#[derive(Clone)]
struct HttpMcpClient {
    inner: Arc<HttpMcpClientInner>,
}

struct HttpMcpClientInner {
    endpoint: String,
    auth_header_name: String,
    auth_header_value: String,
    session_id: String,
    client: reqwest::Client,
    next_request_id: AtomicU64,
}

#[derive(Clone)]
struct HttpMcpTool {
    name: String,
    description: String,
    parameters: Value,
    client: HttpMcpClient,
}

fn truncate_for_error(body: &str) -> String {
    body.chars().take(MAX_ERROR_BODY_CHARS).collect()
}

fn parse_json_rpc_body(body: &str) -> anyhow::Result<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Ok(value);
    }

    // Streamable HTTP transports may return a single JSON-RPC response in an
    // SSE data frame. Ignore comments/event metadata and parse the first data
    // payload that contains a response.
    for line in body.lines() {
        if let Some(data) = line.trim().strip_prefix("data:") {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
                return Ok(value);
            }
        }
    }

    anyhow::bail!(
        "MCP server returned an invalid JSON-RPC response: {}",
        truncate_for_error(body)
    )
}

fn json_rpc_result(response: Value) -> anyhow::Result<Value> {
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("MCP request failed");
        anyhow::bail!("{}", message);
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("MCP response did not include a result"))
}

impl HttpMcpClient {
    async fn connect(
        endpoint: &str,
        auth_header_name: &str,
        auth_header_value: &str,
    ) -> anyhow::Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .build()?;
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "sparky", "version": env!("CARGO_PKG_VERSION") }
            }
        });
        let response = client
            .post(endpoint)
            .header(auth_header_name, auth_header_value)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .json(&initialize)
            .send()
            .await?;
        let status = response.status();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let body = response.text().await?;
        if !status.is_success() {
            anyhow::bail!(
                "MCP initialize failed with HTTP {}: {}",
                status,
                truncate_for_error(&body)
            );
        }
        json_rpc_result(parse_json_rpc_body(&body)?)?;
        let session_id = session_id
            .ok_or_else(|| anyhow::anyhow!("MCP initialize response omitted Mcp-Session-Id"))?;

        Ok(Self {
            inner: Arc::new(HttpMcpClientInner {
                endpoint: endpoint.to_string(),
                auth_header_name: auth_header_name.to_string(),
                auth_header_value: auth_header_value.to_string(),
                session_id,
                client,
                next_request_id: AtomicU64::new(2),
            }),
        })
    }

    async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = self.inner.next_request_id.fetch_add(1, Ordering::Relaxed);
        let response = self
            .inner
            .client
            .post(&self.inner.endpoint)
            .header(&self.inner.auth_header_name, &self.inner.auth_header_value)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .header("mcp-session-id", &self.inner.session_id)
            .header("mcp-protocol-version", MCP_PROTOCOL_VERSION)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .send()
            .await?;
        let status = response.status();
        let body = response.text().await?;
        if !status.is_success() {
            anyhow::bail!(
                "MCP request '{}' failed with HTTP {}: {}",
                method,
                status,
                truncate_for_error(&body)
            );
        }
        json_rpc_result(parse_json_rpc_body(&body)?)
    }

    async fn list_tools(&self) -> anyhow::Result<Vec<HttpMcpTool>> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let result = self.request("tools/list", params).await?;
            let page = result
                .get("tools")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow::anyhow!("MCP tools/list response omitted tools"))?;
            for definition in page {
                let name = definition
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("MCP tool definition omitted name"))?;
                tools.push(HttpMcpTool {
                    name: name.to_string(),
                    description: definition
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("Tool provided by the Sparky desktop app")
                        .to_string(),
                    parameters: definition
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                    client: self.clone(),
                });
            }
            cursor = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        Ok(tools)
    }
}

fn tool_result_output(result: &Value) -> String {
    let mut output = Vec::new();
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        for part in content {
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(Value::as_str) {
                        output.push(text.to_string());
                    }
                }
                Some("image") => {
                    let mime_type = part
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .unwrap_or("image");
                    output.push(format!(
                        "[{} image returned by the browser tool]",
                        mime_type
                    ));
                }
                Some(kind) => output.push(format!("[{} content returned by the MCP tool]", kind)),
                None => {}
            }
        }
    }
    if output.is_empty() {
        if let Some(structured) = result.get("structuredContent") {
            output.push(structured.to_string());
        }
    }
    if output.is_empty() {
        "MCP tool completed without text output.".to_string()
    } else {
        crate::tool::truncate_output(output.join("\n"), MAX_TOOL_OUTPUT_BYTES)
    }
}

#[async_trait]
impl Tool for HttpMcpTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn label(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters(&self) -> Value {
        self.parameters.clone()
    }

    async fn execute(&self, args: Value, _cwd: &str) -> anyhow::Result<ToolExecutionResult> {
        let result = self
            .client
            .request(
                "tools/call",
                json!({
                    "name": self.name,
                    "arguments": args,
                }),
            )
            .await?;
        let output = tool_result_output(&result);
        Ok(
            if result.get("isError").and_then(Value::as_bool) == Some(true) {
                ToolExecutionResult::error(output)
            } else {
                ToolExecutionResult::success(output)
            },
        )
    }
}

/// Discover and register all tools exposed by one authenticated HTTP MCP
/// session. The returned tools share a session-aware client for this process.
pub async fn register_http_mcp_tools(
    registry: &mut ToolRegistry,
    endpoint: &str,
    authorization_header: &str,
) -> anyhow::Result<usize> {
    register_http_mcp_tools_with_header(registry, endpoint, "Authorization", authorization_header)
        .await
}

/// Discover and register HTTP MCP tools using an arbitrary authentication
/// header, such as a provider-specific API-key header.
pub async fn register_http_mcp_tools_with_header(
    registry: &mut ToolRegistry,
    endpoint: &str,
    auth_header_name: &str,
    auth_header_value: &str,
) -> anyhow::Result<usize> {
    let client = HttpMcpClient::connect(endpoint, auth_header_name, auth_header_value).await?;
    let tools = client.list_tools().await?;
    let count = tools.len();
    for tool in tools {
        registry.register(Arc::new(tool));
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_json_and_sse_json_rpc_responses() {
        let json = parse_json_rpc_body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#).unwrap();
        assert_eq!(json["result"]["ok"], true);

        let sse = parse_json_rpc_body(
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"ok\":true}}\n\n",
        )
        .unwrap();
        assert_eq!(sse["result"]["ok"], true);
    }

    #[test]
    fn keeps_text_and_summarizes_binary_tool_content() {
        let result = json!({
            "content": [
                { "type": "text", "text": "{\"url\":\"http://localhost:8080\"}" },
                { "type": "image", "mimeType": "image/png", "data": "large-base64" }
            ]
        });
        let output = tool_result_output(&result);
        assert!(output.contains("localhost:8080"));
        assert!(output.contains("image/png image returned"));
        assert!(!output.contains("large-base64"));
    }
}
