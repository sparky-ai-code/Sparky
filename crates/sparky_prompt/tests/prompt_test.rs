use sparky_prompt::PromptBuilder;

#[tokio::test]
async fn loads_supported_context_and_skips_gitignored_files() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".codex")).unwrap();
    std::fs::create_dir_all(root.join(".sparky/nested")).unwrap();
    std::fs::create_dir_all(root.join(".sparky/skills")).unwrap();
    std::fs::create_dir_all(root.join("ignored/.sparky")).unwrap();
    std::fs::write(
        root.join(".gitignore"),
        ".sparky/ignored.md\n.sparky/skills/ignored.md\nignored/\n",
    )
    .unwrap();
    std::fs::write(root.join(".cursorrules"), "cursor rules").unwrap();
    std::fs::write(root.join(".claude.md"), "claude rules").unwrap();
    std::fs::write(root.join(".codex/instructions.md"), "codex rules").unwrap();
    std::fs::write(root.join(".sparky/nested/rules.md"), "sparky rules").unwrap();
    std::fs::write(root.join(".sparky/ignored.md"), "ignored context").unwrap();
    std::fs::write(root.join(".sparky/skills/visible.md"), "visible skill").unwrap();
    std::fs::write(root.join(".sparky/skills/ignored.md"), "ignored skill").unwrap();
    std::fs::write(root.join("ignored/.sparky/no.md"), "ignored tree").unwrap();

    let builder = PromptBuilder::new(root.to_string_lossy());
    let context = builder.load_context_files().await;
    let context_paths: Vec<_> = context.iter().map(|file| file.path.as_str()).collect();
    assert!(context_paths.contains(&".cursorrules"));
    assert!(context_paths.contains(&".claude.md"));
    assert!(context_paths.contains(&".codex/instructions.md"));
    assert!(context_paths.contains(&".sparky/nested/rules.md"));
    assert!(!context_paths.contains(&".sparky/ignored.md"));
    assert!(!context_paths
        .iter()
        .any(|path| path.starts_with("ignored/")));

    let skills = builder.load_skills().await;
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].name, "visible");
    assert_eq!(skills[0].content, "visible skill");
}

#[tokio::test]
async fn plan_mode_uses_read_only_prompt_and_still_loads_context() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::write(root.join("AGENTS.md"), "Prefer focused changes").unwrap();

    let prompt = sparky_prompt::PromptBuilder::new(root.to_string_lossy())
        .with_plan_mode(true)
        .build()
        .await;

    assert!(prompt.contains("Plan mode"));
    assert!(prompt.contains("Never call write, edit, bash"));
    assert!(prompt.contains("end_task"));
    assert!(prompt.contains("<project_context>"));
    assert!(prompt.contains("Prefer focused changes"));

    let build_prompt = sparky_prompt::PromptBuilder::new(root.to_string_lossy())
        .with_plan_mode(false)
        .build()
        .await;
    assert!(build_prompt.contains("You are Sparky, an expert AI coding assistant"));
    assert!(build_prompt.contains("end_task"));
    assert!(build_prompt.contains("The in-app browser is an interaction and verification tool"));
    assert!(build_prompt.contains("Never invent, call, or suggest a fallback search engine"));
    assert!(build_prompt.contains("Do not mention search providers, indexing, ranking"));
    assert!(!build_prompt.contains("You are Sparky in Plan mode"));
}

#[tokio::test]
async fn loads_ancestor_agents_in_hierarchy_order() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let nested = root.join("packages/app");
    std::fs::create_dir_all(&nested).unwrap();
    std::fs::write(root.join("AGENTS.md"), "root instructions").unwrap();
    std::fs::write(nested.join("AGENTS.md"), "nested instructions").unwrap();

    let context = PromptBuilder::new(nested.to_string_lossy())
        .load_context_files()
        .await;
    let contents: Vec<_> = context.iter().map(|file| file.content.as_str()).collect();

    assert_eq!(contents, vec!["root instructions", "nested instructions"]);
}

#[tokio::test]
async fn custom_prompt_still_receives_workspace_instructions_and_skill_catalog() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    std::fs::create_dir_all(root.join(".agents/skills/example")).unwrap();
    std::fs::write(root.join("AGENTS.md"), "workspace instructions").unwrap();
    std::fs::write(
        root.join(".agents/skills/example/SKILL.md"),
        "---\nname: example\ndescription: Example skill\n---\nskill body",
    )
    .unwrap();

    let prompt = PromptBuilder::new(root.to_string_lossy())
        .with_custom_prompt(Some("custom system prompt".to_string()))
        .build()
        .await;

    assert!(prompt.starts_with("custom system prompt"));
    assert!(prompt.contains("workspace instructions"));
    assert!(prompt.contains("path=\".agents/skills/example/SKILL.md\""));
    assert!(!prompt.contains("skill body"));
}
