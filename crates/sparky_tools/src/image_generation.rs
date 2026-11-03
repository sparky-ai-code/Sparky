use crate::path_guard::{resolve_write_path, validate_created_parent};
use crate::tool::{Tool, ToolExecutionMode, ToolExecutionResult};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone)]
pub struct ImageGenerationTool {
    api_key: Option<String>,
    codex_oauth: bool,
    client: reqwest::Client,
}

impl ImageGenerationTool {
    pub fn new(api_key: Option<String>, codex_oauth: bool) -> Self {
        Self {
            api_key: api_key.filter(|key| !key.trim().is_empty()),
            codex_oauth,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(300))
                .build()
                .expect("valid OpenAI image HTTP client configuration"),
        }
    }
}

#[async_trait]
impl Tool for ImageGenerationTool {
    fn name(&self) -> &str {
        "image_generation"
    }

    fn label(&self) -> &str {
        "Generate Image"
    }

    fn description(&self) -> &str {
        "Generate an image with an OpenAI GPT Image model and save it in the current workspace."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "What the image should depict." },
                "model": {
                    "type": "string",
                    "enum": ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5", "gpt-image-1-mini"],
                    "description": "OpenAI image model. Defaults to gpt-image-2.5-sunburst."
                },
                "size": {
                    "type": "string",
                    "enum": ["1024x1024", "1536x1024", "1024x1536", "auto"],
                    "description": "Image dimensions. Defaults to auto."
                },
                "quality": {
                    "type": "string",
                    "enum": ["low", "medium", "high", "auto"],
                    "description": "Image quality. Defaults to auto."
                },
                "path": { "type": "string", "description": "Optional output path relative to the workspace. Defaults to a unique file under generated-images/." }
            },
            "required": ["prompt"]
        })
    }

    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }

    async fn execute(&self, args: Value, cwd: &str) -> anyhow::Result<ToolExecutionResult> {
        let Some(prompt) = args.get("prompt").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) else {
            return Ok(ToolExecutionResult::error("A non-empty prompt is required."));
        };
        let model = args
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("gpt-image-2.5-sunburst");
        if ![
            "gpt-image-2.5-sunburst",
            "gpt-image-2.5-flare",
            "gpt-image-2",
            "gpt-image-1.5",
            "gpt-image-1-mini",
        ]
        .contains(&model)
        {
            return Ok(ToolExecutionResult::error("Unsupported OpenAI image model."));
        }
        let size = args.get("size").and_then(Value::as_str).unwrap_or("auto");
        if !["1024x1024", "1536x1024", "1024x1536", "auto"].contains(&size) {
            return Ok(ToolExecutionResult::error("Unsupported image size."));
        }
        let quality = args.get("quality").and_then(Value::as_str).unwrap_or("auto");
        if !["low", "medium", "high", "auto"].contains(&quality) {
            return Ok(ToolExecutionResult::error("Unsupported image quality."));
        }
        let path = args.get("path").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| {
            let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
            format!("generated-images/image-{timestamp}.png")
        });
        let output_path = match resolve_write_path(cwd, &path) {
            Ok(path) => path,
            Err(error) => return Ok(ToolExecutionResult::error(error.to_string())),
        };
        if output_path.extension().and_then(|extension| extension.to_str()) != Some("png") {
            return Ok(ToolExecutionResult::error(
                "The image tool currently saves PNG files; provide a .png output path.",
            ));
        }

        let (token, is_oauth) = if self.codex_oauth {
            match sparky_ai::codex_auth::valid_codex_credentials().await {
                Ok(credentials) => (credentials.access, true),
                Err(error) => return Ok(ToolExecutionResult::error(format!("Codex OAuth is unavailable: {error}"))),
            }
        } else if let Some(key) = &self.api_key {
            (key.clone(), false)
        } else {
            return Ok(ToolExecutionResult::error("Image generation requires OpenAI API-key or Codex OAuth authentication."));
        };

        let body = json!({
            "model": "gpt-5.4",
            "input": prompt,
            "tools": [{
                "type": "image_generation",
                "model": model,
                "size": size,
                "quality": quality,
                "output_format": "png"
            }],
            "tool_choice": { "type": "image_generation" },
            "store": false
        });
        let response = self
            .client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(token)
            .header(
                "User-Agent",
                concat!("sparky-rust/", env!("CARGO_PKG_VERSION")),
            )
            .json(&body)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(error) => return Ok(ToolExecutionResult::error(format!("OpenAI image request failed: {error}"))),
        };
        if !response.status().is_success() {
            let status = response.status();
            let detail = response.text().await.unwrap_or_default();
            let auth_kind = if is_oauth { "Codex OAuth" } else { "OpenAI API key" };
            return Ok(ToolExecutionResult::error(format!("OpenAI image generation failed for {auth_kind} (HTTP {status}): {}", detail.chars().take(1_000).collect::<String>())));
        }
        let response: Value = match response.json().await {
            Ok(value) => value,
            Err(error) => return Ok(ToolExecutionResult::error(format!("Unable to read OpenAI image response: {error}"))),
        };
        let Some(encoded_image) = response["output"].as_array().into_iter().flatten()
            .find(|item| item["type"] == "image_generation_call")
            .and_then(|item| item["result"].as_str())
        else {
            return Ok(ToolExecutionResult::error("OpenAI completed the response without returning an image."));
        };
        let image = match STANDARD.decode(encoded_image) {
            Ok(image) => image,
            Err(error) => return Ok(ToolExecutionResult::error(format!("OpenAI returned invalid image data: {error}"))),
        };
        if let Some(parent) = output_path.parent() {
            if let Err(error) = tokio::fs::create_dir_all(parent).await {
                return Ok(ToolExecutionResult::error(format!("Unable to create output directory: {error}")));
            }
        }
        if let Err(error) = validate_created_parent(cwd, &output_path, Path::new(&path).is_absolute()) {
            return Ok(ToolExecutionResult::error(error.to_string()));
        }
        match tokio::fs::OpenOptions::new().write(true).create_new(true).open(&output_path).await {
            Ok(mut file) => {
                use tokio::io::AsyncWriteExt;
                if let Err(error) = file.write_all(&image).await {
                    let _ = tokio::fs::remove_file(&output_path).await;
                    return Ok(ToolExecutionResult::error(format!("Unable to save generated image: {error}")));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Ok(ToolExecutionResult::error(format!("Refusing to overwrite existing file: {path}")));
            }
            Err(error) => return Ok(ToolExecutionResult::error(format!("Unable to save generated image: {error}"))),
        }
        Ok(ToolExecutionResult::success(format!(
            "Generated image saved to `{path}` ({} bytes). Show it inline in the final response with `![Generated image](<{path}>)`.",
            image.len()
        )))
    }
}
