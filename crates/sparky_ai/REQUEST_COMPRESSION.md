# Provider request-body compression

`request_body::encode_json` serializes a JSON body once before retry handling. For eligible endpoints it gzips bodies of at least 1,024 uncompressed bytes and sends `Content-Type: application/json` with `Content-Encoding: gzip`. Retry attempts reuse the encoded bytes. Small bodies are sent as ordinary JSON.

Compression is enabled only for the canonical Anthropic API URL and Cerebras API URL. Cerebras documents `Content-Encoding: gzip` for Chat Completions in its [payload optimization](https://inference-docs.cerebras.ai/capabilities/payload-optimization) and [Chat Completions reference](https://inference-docs.cerebras.ai/api-reference/chat-completions). Anthropic's canonical endpoint has been observed accepting gzip-compressed Messages API requests; this behavior is not documented in Anthropic's API reference, so the implementation deliberately scopes it to `https://api.anthropic.com/v1` only.

Other direct transports remain uncompressed: Gemini; OpenAI; Fireworks; Ollama Cloud; Groq; local Ollama; and custom/overridden base URLs, because gzip request-body support is not confirmed for those destinations. OpenAI Codex requests are delegated to the Codex runtime, so Sparky does not own their HTTP request bodies. The TypeScript server similarly hands provider execution to its provider/runtime drivers; its own HTTP/WebSocket and snapshot routes are unrelated.

## Reproduce the size measurement

Run `cargo test -p sparky_ai request_body::tests::gzip_round_trips_json_and_shrinks_repetitive_payloads -- --nocapture`. The test prints raw and gzip byte counts and percentage reduction for a generated repetitive 170 KB text prompt, verifies round-trip decompression, and does not make a network request. It measures payload size only, not upload time or time-to-first-token. Network timing requires a controlled provider endpoint and account; no general latency improvement is claimed. Compression's potential upload-time benefit depends on payload compressibility and connection throughput, while compression CPU and model generation time are separate costs.
