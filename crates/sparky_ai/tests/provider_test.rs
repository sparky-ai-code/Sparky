use sparky_ai::formatting::{anthropic_messages, gemini_messages, openai_messages};
use sparky_ai::{
    AnthropicProvider, CompletionOptions, GeminiProvider, LlmProvider, Message, OpenAiProvider,
    ToolCall,
};

fn tool_conversation() -> Vec<Message> {
    vec![
        Message::system("system rules"),
        Message::user("read the file"),
        Message::assistant(
            "",
            Some(vec![ToolCall {
                id: "call-1".to_string(),
                name: "read".to_string(),
                arguments: serde_json::json!({ "path": "README.md" }),
            }]),
        ),
        Message::tool_result("call-1", "file contents", false),
    ]
}

#[test]
fn formats_openai_tool_conversation() {
    let messages = openai_messages(&tool_conversation());
    assert_eq!(messages[0]["role"], "system");
    assert_eq!(messages[2]["tool_calls"][0]["function"]["name"], "read");
    assert_eq!(messages[3]["role"], "tool");
    assert_eq!(messages[3]["tool_call_id"], "call-1");
}

#[test]
fn formats_anthropic_tool_conversation() {
    let (system, messages) = anthropic_messages(&tool_conversation());
    assert_eq!(system, "system rules");
    assert_eq!(messages[1]["content"][0]["type"], "tool_use");
    assert_eq!(messages[2]["content"][0]["type"], "tool_result");
    assert_eq!(messages[2]["content"][0]["tool_use_id"], "call-1");
}

#[test]
fn formats_gemini_tool_conversation() {
    let (system, messages) = gemini_messages(&tool_conversation());
    assert_eq!(system.unwrap()["parts"][0]["text"], "system rules");
    assert_eq!(messages[1]["role"], "model");
    assert_eq!(messages[1]["parts"][0]["functionCall"]["name"], "read");
    assert_eq!(
        messages[2]["parts"][0]["functionResponse"]["name"],
        "call-1"
    );
}

#[tokio::test]
async fn hosted_providers_reject_empty_api_keys_before_network_access() {
    let messages = vec![Message::user("hello")];
    let options = CompletionOptions::default();

    let openai = OpenAiProvider::new("", Some("https://example.invalid/v1".to_string()));
    let anthropic = AnthropicProvider::new("", Some("https://example.invalid".to_string()));
    let gemini = GeminiProvider::new("");

    assert!(openai
        .complete(&messages, &options)
        .await
        .unwrap_err()
        .to_string()
        .contains("OPENAI_API_KEY"));
    assert!(anthropic
        .complete(&messages, &options)
        .await
        .unwrap_err()
        .to_string()
        .contains("ANTHROPIC_API_KEY"));
    assert!(gemini
        .complete(&messages, &options)
        .await
        .unwrap_err()
        .to_string()
        .contains("GEMINI_API_KEY"));
}
