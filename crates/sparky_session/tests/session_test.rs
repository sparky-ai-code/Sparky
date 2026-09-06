use sparky_ai::{ContentPart, Message, Role, ToolCall};
use sparky_session::{SessionEntry, SessionManager};
use tempfile::tempdir;

#[tokio::test]
async fn test_session_manager_flow() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();

    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    assert!(!session.session_id().is_empty());

    let id1 = session
        .append_message(Message::user("Hello Sparky"))
        .await
        .unwrap();
    let id2 = session
        .append_message(Message::assistant("Hello! How can I help you?", None))
        .await
        .unwrap();

    assert_ne!(id1, id2);
    assert_eq!(id1.len(), 36);
    assert_eq!(id2.len(), 36);
    assert_eq!(uuid::Uuid::parse_str(&id1).unwrap().to_string(), id1);
    assert_eq!(uuid::Uuid::parse_str(&id2).unwrap().to_string(), id2);

    let messages = session.build_context_messages();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].text(), "Hello Sparky");
    assert_eq!(messages[1].text(), "Hello! How can I help you?");
    session.save().await.unwrap();
}

#[tokio::test]
async fn resumes_the_exact_session_with_its_message_history() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let session_id = {
        let mut session = SessionManager::create_new(cwd, None).await.unwrap();
        session
            .append_message(Message::user("Build a blue dashboard"))
            .await
            .unwrap();
        session
            .append_message(Message::assistant("I built the dashboard.", None))
            .await
            .unwrap();
        session.session_id().to_string()
    };

    let mut resumed = SessionManager::load(cwd, &session_id).await.unwrap();
    let before_follow_up = resumed.build_context_messages();
    assert_eq!(before_follow_up.len(), 2);
    assert_eq!(before_follow_up[0].text(), "Build a blue dashboard");
    assert_eq!(before_follow_up[1].text(), "I built the dashboard.");

    resumed
        .append_message(Message::user("Make that dashboard green"))
        .await
        .unwrap();
    let after_follow_up = resumed.build_context_messages();
    assert_eq!(after_follow_up.len(), 3);
    assert_eq!(after_follow_up[2].text(), "Make that dashboard green");
}

#[tokio::test]
async fn loads_existing_sessions_with_opaque_provider_state() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let session = SessionManager::create_new(cwd, None).await.unwrap();
    let session_id = session.session_id().to_string();
    let session_file = session.session_file().to_path_buf();
    drop(session);

    let mut contents = tokio::fs::read_to_string(&session_file).await.unwrap();
    let entry_id = uuid::Uuid::new_v4().to_string();
    let entry = serde_json::json!({
        "type": "message",
        "id": entry_id,
        "parent_id": null,
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "message": {
            "role": "assistant",
            "content": [
                { "type": "text", "text": "The visible reply." },
                {
                    "type": "provider_state",
                    "provider": "openai-codex",
                    "data": {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "encrypted_content": "opaque-state",
                        "summary": []
                    }
                }
            ],
            "timestamp": 1,
            "provider": "openai-codex",
            "model": "gpt-5.6-sol"
        }
    });
    contents.push_str(&format!("{}\n", serde_json::to_string(&entry).unwrap()));
    tokio::fs::write(&session_file, contents).await.unwrap();

    let resumed = SessionManager::load(cwd, &session_id).await.unwrap();
    let messages = resumed.build_context_messages();

    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text(), "The visible reply.");
    assert!(messages[0].content.iter().any(|part| {
        matches!(
            part,
            ContentPart::ProviderState { provider, data }
                if provider == "openai-codex"
                    && data["encrypted_content"] == "opaque-state"
        )
    }));
}

#[tokio::test]
async fn rejects_non_uuid_session_paths() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();

    let error = SessionManager::load(cwd, "..\\outside")
        .await
        .err()
        .expect("path-like session ids must be rejected");
    assert!(error.to_string().contains("Invalid Sparky session id"));
}

#[tokio::test]
async fn compaction_trims_memory_and_rebuilds_summary_plus_kept_messages() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();

    session
        .append_message(Message::user("old one"))
        .await
        .unwrap();
    session
        .append_message(Message::assistant("old two", None))
        .await
        .unwrap();
    let first_kept_id = session
        .append_message(Message::user("recent one"))
        .await
        .unwrap();
    session
        .append_message(Message::assistant("recent two", None))
        .await
        .unwrap();

    let compaction_id = uuid::Uuid::new_v4().to_string();
    session
        .append_entry(SessionEntry::Compaction {
            id: compaction_id,
            parent_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            summary: "summary of old messages".to_string(),
            first_kept_entry_id: first_kept_id.clone(),
            tokens_before: 42,
        })
        .await
        .unwrap();

    assert_eq!(session.trim_entries_before(&first_kept_id).unwrap(), 2);
    assert_eq!(session.entry_count(), 3);

    let messages = session.build_context_messages();
    assert_eq!(messages.len(), 3);
    assert_eq!(
        messages[0].text(),
        "[Compaction Summary]: summary of old messages"
    );
    assert_eq!(messages[1].text(), "recent one");
    assert_eq!(messages[2].text(), "recent two");

    session
        .append_message(Message::user("after compaction"))
        .await
        .unwrap();
    let reloaded = SessionManager::load(cwd, session.session_id())
        .await
        .unwrap();
    assert_eq!(reloaded.entry_count(), 4);
    let reloaded_messages = reloaded.build_context_messages();
    assert_eq!(reloaded_messages.len(), 4);
    assert_eq!(
        reloaded_messages[0].text(),
        "[Compaction Summary]: summary of old messages"
    );
    assert_eq!(reloaded_messages[3].text(), "after compaction");
}

#[tokio::test]
async fn concurrent_managers_append_complete_json_lines() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let session = SessionManager::create_new(cwd, None).await.unwrap();
    let session_id = session.session_id().to_string();
    let session_file = session.session_file().to_path_buf();
    drop(session);

    let mut first = SessionManager::load(cwd, &session_id).await.unwrap();
    let mut second = SessionManager::load(cwd, &session_id).await.unwrap();
    let (first_result, second_result) = tokio::join!(
        async {
            for index in 0..50 {
                first
                    .append_message(Message::user(format!("first-{index}")))
                    .await?;
            }
            anyhow::Ok(())
        },
        async {
            for index in 0..50 {
                second
                    .append_message(Message::user(format!("second-{index}")))
                    .await?;
            }
            anyhow::Ok(())
        }
    );
    first_result.unwrap();
    second_result.unwrap();

    let content = tokio::fs::read_to_string(session_file).await.unwrap();
    let lines: Vec<_> = content.lines().collect();
    assert_eq!(lines.len(), 101);
    for line in lines {
        serde_json::from_str::<serde_json::Value>(line).unwrap();
    }
}

#[tokio::test]
async fn custom_messages_are_restored_as_user_context() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    session
        .append_entry(SessionEntry::CustomMessage {
            id: uuid::Uuid::new_v4().to_string(),
            parent_id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            custom_type: "note".to_string(),
            content: "remember this constraint".to_string(),
            display: false,
        })
        .await
        .unwrap();

    let reloaded = SessionManager::load(cwd, session.session_id())
        .await
        .unwrap();
    let context = reloaded.build_context_messages();
    assert_eq!(context.len(), 1);
    assert_eq!(context[0].text(), "remember this constraint");
}

#[tokio::test]
async fn interrupted_tool_calls_are_repaired_before_the_next_message() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    session
        .append_message(Message::user("Start the preview server"))
        .await
        .unwrap();
    session
        .append_message(Message::assistant(
            "",
            Some(vec![ToolCall {
                id: "call-preview".to_string(),
                name: "bash".to_string(),
                arguments: serde_json::json!({ "command": "python -m http.server 8080" }),
            }]),
        ))
        .await
        .unwrap();
    session
        .append_message(Message::user("Test it in the browser"))
        .await
        .unwrap();

    let context = session.build_context_messages();
    assert_eq!(context.len(), 4);
    assert_eq!(context[2].role, Role::Tool);
    let repaired = context[2].tool_result.as_ref().unwrap();
    assert_eq!(repaired.tool_call_id, "call-preview");
    assert!(repaired.is_error);
    assert!(repaired.output.contains("interrupted"));
    assert_eq!(context[3].text(), "Test it in the browser");
}

#[tokio::test]
async fn complete_tool_calls_are_not_modified_and_orphan_results_are_removed() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let mut session = SessionManager::create_new(cwd, None).await.unwrap();
    session
        .append_message(Message::assistant(
            "",
            Some(vec![ToolCall {
                id: "call-status".to_string(),
                name: "preview_status".to_string(),
                arguments: serde_json::json!({}),
            }]),
        ))
        .await
        .unwrap();
    session
        .append_message(Message::tool_result("call-status", "ready", false))
        .await
        .unwrap();
    session
        .append_message(Message::tool_result("orphan", "invalid", false))
        .await
        .unwrap();

    let context = session.build_context_messages();
    assert_eq!(context.len(), 2);
    assert_eq!(context[1].tool_result.as_ref().unwrap().output, "ready");
}
