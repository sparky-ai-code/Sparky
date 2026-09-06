use crate::tool::{truncate_output, Tool, ToolExecutionResult};
use async_trait::async_trait;
use regex::Regex;
use serde_json::json;
use url::Url;

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }

    fn label(&self) -> &str {
        "Web Search"
    }

    fn description(&self) -> &str {
        "Search the web for documentation, solutions, API references, or other current information. Results include titles, snippets, and URLs."
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

        match search_duckduckgo(query, max_results).await {
            Ok(results) => {
                if results.is_empty() {
                    Ok(ToolExecutionResult::success("No results found."))
                } else {
                    let output = truncate_output(
                        format_results(&results),
                        sparky_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
                    );
                    Ok(ToolExecutionResult::success(output))
                }
            }
            Err(_) => Ok(ToolExecutionResult::error(
                "Search failed: unable to fetch current results.",
            )),
        }
    }
}

#[derive(Debug)]
struct SearchResult {
    title: String,
    snippet: String,
    url: String,
}

fn normalize_result_url(raw_url: &str) -> Option<String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return None;
    }

    let absolute = if trimmed.starts_with("//") {
        format!("https:{trimmed}")
    } else if trimmed.starts_with('/') {
        format!("https://duckduckgo.com{trimmed}")
    } else {
        trimmed.to_string()
    };

    let parsed = Url::parse(&absolute).ok()?;
    if parsed.host_str() == Some("duckduckgo.com") && parsed.path() == "/l/" {
        if let Some(target) = parsed
            .query_pairs()
            .find_map(|(key, value)| (key == "uddg").then(|| value.into_owned()))
        {
            return Url::parse(&target).ok().map(|url| url.to_string());
        }
    }

    Some(absolute)
}

fn push_result(
    results: &mut Vec<SearchResult>,
    seen_urls: &mut std::collections::HashSet<String>,
    title: String,
    snippet: String,
    raw_url: &str,
    max_results: usize,
) {
    if results.len() >= max_results {
        return;
    }
    let Some(url) = normalize_result_url(raw_url) else {
        return;
    };
    if !seen_urls.insert(url.clone()) {
        return;
    }
    results.push(SearchResult {
        title,
        snippet,
        url,
    });
}

fn clean_html_fragment(fragment: &str, tag_re: &Regex) -> String {
    let without_tags = tag_re.replace_all(fragment, "");
    decode_html_entities(&without_tags)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_html_results(body: &str, max_results: usize) -> Vec<SearchResult> {
    let result_re = Regex::new(
        r##"(?s)<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>(.*?)</a>"##,
    )
    .expect("web search result regex must compile");
    let snippet_re = Regex::new(
        r##"(?s)<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*href="[^"]*"[^>]*>(.*?)</a>"##,
    )
    .expect("web search snippet regex must compile");
    let tag_re = Regex::new(r"<[^>]+>").expect("web search HTML tag regex must compile");
    let urls: Vec<String> = result_re
        .captures_iter(body)
        .map(|capture| capture[1].to_string())
        .collect();
    let titles: Vec<String> = result_re
        .captures_iter(body)
        .map(|capture| clean_html_fragment(&capture[2], &tag_re))
        .collect();
    let snippets: Vec<String> = snippet_re
        .captures_iter(body)
        .map(|capture| clean_html_fragment(&capture[1], &tag_re))
        .collect();

    let mut results = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();
    for (index, url) in urls.iter().enumerate() {
        push_result(
            &mut results,
            &mut seen_urls,
            titles.get(index).cloned().unwrap_or_default(),
            snippets.get(index).cloned().unwrap_or_default(),
            url,
            max_results,
        );
    }
    results
}

async fn search_duckduckgo(query: &str, max_results: usize) -> anyhow::Result<Vec<SearchResult>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (compatible; SparkySearch/1.0)")
        .build()?;

    // First try the Instant Answer API for quick structured data
    let api_url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1",
        urlencoding(query)
    );

    let mut all_results: Vec<SearchResult> = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();

    if let Ok(resp) = client.get(&api_url).send().await {
        if resp.status().is_success() {
            if let Ok(body) = resp.text().await {
                if let Ok(ddg_response) = serde_json::from_str::<serde_json::Value>(&body) {
                    // Extract abstract
                    if let Some(abstract_text) = ddg_response["AbstractText"].as_str() {
                        if !abstract_text.is_empty() {
                            let url = ddg_response["AbstractURL"].as_str().unwrap_or("");
                            let source = ddg_response["AbstractSource"].as_str().unwrap_or("");
                            push_result(
                                &mut all_results,
                                &mut seen_urls,
                                format!("{} - {}", source, truncate(abstract_text, 80)),
                                abstract_text.to_string(),
                                url,
                                max_results,
                            );
                        }
                    }

                    // Extract related topics
                    if let Some(topics) = ddg_response["RelatedTopics"].as_array() {
                        for topic in topics {
                            if all_results.len() >= max_results {
                                break;
                            }
                            if let Some(text) = topic["Text"].as_str() {
                                let url = topic["FirstURL"].as_str().unwrap_or("");
                                if !text.is_empty() {
                                    push_result(
                                        &mut all_results,
                                        &mut seen_urls,
                                        truncate(text, 80).to_string(),
                                        text.to_string(),
                                        url,
                                        max_results,
                                    );
                                }
                            }
                            // Check nested topics
                            if let Some(topics) = topic["Topics"].as_array() {
                                for sub in topics {
                                    if all_results.len() >= max_results {
                                        break;
                                    }
                                    if let Some(text) = sub["Text"].as_str() {
                                        let url = sub["FirstURL"].as_str().unwrap_or("");
                                        if !text.is_empty() {
                                            push_result(
                                                &mut all_results,
                                                &mut seen_urls,
                                                truncate(text, 80).to_string(),
                                                text.to_string(),
                                                url,
                                                max_results,
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    // Extract external results
                    if let Some(results) = ddg_response["Results"].as_array() {
                        for result in results {
                            if all_results.len() >= max_results {
                                break;
                            }
                            let text = result["Text"].as_str().unwrap_or("");
                            let url = result["FirstURL"].as_str().unwrap_or("");
                            if !text.is_empty() {
                                push_result(
                                    &mut all_results,
                                    &mut seen_urls,
                                    truncate(text, 80).to_string(),
                                    text.to_string(),
                                    url,
                                    max_results,
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // If we don't have enough results, also scrape the HTML search page
    if all_results.len() < max_results {
        let html_url = format!("https://html.duckduckgo.com/html/?q={}", urlencoding(query));

        if let Ok(resp) = client.get(&html_url).send().await {
            if let Ok(body) = resp.text().await {
                all_results.extend(parse_html_results(&body, max_results - all_results.len()));
            }
        }
    }

    // Trim to max_results
    all_results.truncate(max_results);
    Ok(all_results)
}

fn format_results(results: &[SearchResult]) -> String {
    let mut output = String::new();
    output.push_str(&format!("Web search results ({}):\n\n", results.len()));
    for (i, r) in results.iter().enumerate() {
        output.push_str(&format!("{}. {}\n", i + 1, r.title));
        output.push_str(&format!("   URL: {}\n", r.url));
        if !r.snippet.is_empty() {
            output.push_str(&format!("   {}\n", r.snippet));
        }
        output.push('\n');
    }
    output
}

fn urlencoding(query: &str) -> String {
    let mut encoded = String::new();
    for byte in query.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            b' ' => encoded.push_str("+"),
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

fn truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        s
    } else {
        &s[..max]
    }
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&#x2F;", "/")
        .replace("&nbsp;", " ")
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
    fn unwraps_provider_redirect_links() {
        assert_eq!(
            normalize_result_url(
                "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=test"
            ),
            Some("https://example.com/docs".to_string())
        );
    }

    #[test]
    fn parses_current_html_result_markup() {
        let results = parse_html_results(
            r#"
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">Example <em>docs</em></a>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs">A &amp; useful <b>snippet</b>.</a>
            "#,
            5,
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example docs");
        assert_eq!(results[0].snippet, "A & useful snippet.");
        assert_eq!(results[0].url, "https://example.com/docs");
    }
    #[test]
    fn deduplicates_normalized_result_links() {
        let mut results = Vec::new();
        let mut seen_urls = std::collections::HashSet::new();
        push_result(
            &mut results,
            &mut seen_urls,
            "Example".to_string(),
            "First".to_string(),
            "//example.com/docs",
            5,
        );
        push_result(
            &mut results,
            &mut seen_urls,
            "Example again".to_string(),
            "Second".to_string(),
            "https://example.com/docs",
            5,
        );

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].url, "https://example.com/docs");
    }
}
