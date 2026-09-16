use crate::tool::{truncate_output, Tool, ToolExecutionResult};
use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use url::Url;

pub struct WebSearchTool;

const DEFAULT_SEARCH_WORKER_URL: &str = "https://sparky.llc/search";
const SEARCH_WORKER_URL_ENV_VAR: &str = "SPARKY_SEARCH_WORKER_URL";

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }

    fn label(&self) -> &str {
        "Web Search"
    }

    fn description(&self) -> &str {
        "Search the public web for current information, documentation, news, and official sources. Results come from Sparky's hosted Exa search service."
    }

    fn parameters(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query (e.g. 'Python std::fs read file', 'Rust serde derive macro docs', 'Next.js 14 app router middleware')"
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5, max: 10)",
                    "default": 5
                }
            },
            "required": ["query"]
        })
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        _cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult> {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) => q.trim(),
            None => return Ok(ToolExecutionResult::error("Missing 'query' parameter")),
        };

        if query.is_empty() {
            return Ok(ToolExecutionResult::error("Query cannot be empty"));
        }

        let max_results = args
            .get("max_results")
            .and_then(|v| v.as_i64())
            .unwrap_or(5)
            .min(10)
            .max(1) as usize;

        let results = match search_worker(query, max_results).await {
            Ok(results) => results,
            Err(error) => {
                tracing::warn!(error = %error, "Hosted Exa search unavailable");
                return Ok(ToolExecutionResult::error(
                    "Search is temporarily unavailable. Please try again in a moment.",
                ));
            }
        };

        if results.is_empty() {
            Ok(ToolExecutionResult::success("No useful results found."))
        } else {
            let output = truncate_output(
                format_results(&results),
                sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
            );
            Ok(ToolExecutionResult::success(output))
        }
    }
}

#[derive(Debug, Serialize)]
struct SearchResult {
    title: String,
    snippet: String,
    url: String,
    favicon_url: String,
}

fn search_worker_url() -> String {
    std::env::var(SEARCH_WORKER_URL_ENV_VAR)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SEARCH_WORKER_URL.to_string())
}

async fn search_worker(query: &str, max_results: usize) -> anyhow::Result<Vec<SearchResult>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (compatible; SparkySearch/1.0)")
        .build()?;
    let request = client.post(search_worker_url()).json(&json!({
        "query": query,
        "max_results": max_results,
    }));
    let response = request.send().await?;
    let status = response.status();
    anyhow::ensure!(status.is_success(), "Search worker returned HTTP {status}");
    let body = response.json::<serde_json::Value>().await?;
    Ok(parse_search_worker_results(&body, max_results))
}

fn parse_search_worker_results(body: &serde_json::Value, max_results: usize) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    for result in body["results"].as_array().into_iter().flatten() {
        let Some(url) = result["url"].as_str().and_then(normalize_result_url) else {
            continue;
        };
        if !seen_urls.insert(url.clone()) {
            continue;
        }
        results.push(SearchResult {
            title: truncate_chars(result["title"].as_str().unwrap_or(&url), 160),
            snippet: truncate_chars(result["snippet"].as_str().unwrap_or_default(), 600),
            url,
            favicon_url: result["favicon_url"]
                .as_str()
                .and_then(normalize_result_url)
                .unwrap_or_default(),
        });
        if results.len() >= max_results {
            break;
        }
    }
    results
}

fn normalize_result_url(raw_url: &str) -> Option<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let absolute = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else {
        trimmed.to_string()
    };

    let parsed = Url::parse(&absolute).ok()?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return None;
    }
    Some(absolute)
}

fn format_results(results: &[SearchResult]) -> String {
    serde_json::to_string_pretty(&json!({
        "results": results,
    }))
    .expect("web search result payload must serialize")
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_protocol_relative_result_links() {
        assert_eq!(
            normalize_result_url("//example.com/docs"),
            Some("https://example.com/docs".to_string())
        );
    }

    #[test]
    fn rejects_non_http_result_links() {
        assert_eq!(normalize_result_url("ftp://example.com/file"), None);
        assert_eq!(normalize_result_url("javascript:alert(1)"), None);
    }

    #[test]
    fn formats_result_urls_and_favicons_for_the_timeline() {
        let output = format_results(&[SearchResult {
            title: "Serde docs".to_string(),
            snippet: "Serialization framework".to_string(),
            url: "https://serde.rs".to_string(),
            favicon_url: "https://serde.rs/favicon.ico".to_string(),
        }]);
        let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();

        assert!(parsed["provider"].is_null());
        assert_eq!(parsed["results"][0]["url"], "https://serde.rs");
        assert_eq!(
            parsed["results"][0]["favicon_url"],
            "https://serde.rs/favicon.ico"
        );
    }
    #[test]
    fn treats_malformed_worker_results_as_empty() {
        let results = parse_search_worker_results(&serde_json::json!({ "results": "invalid" }), 5);
        assert!(results.is_empty());
    }
}
