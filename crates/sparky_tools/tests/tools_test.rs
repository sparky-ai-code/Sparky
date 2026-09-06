use sparky_tools::{EditTool, FindTool, GrepTool, LsTool, ReadTool, Tool, WriteTool};
use tempfile::tempdir;

#[tokio::test]
async fn test_write_read_edit_tools() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();

    let write_tool = WriteTool;
    let read_tool = ReadTool::default();
    let edit_tool = EditTool;

    // Test Write
    let write_res = write_tool
        .execute(
            serde_json::json!({
                "path": "test.txt",
                "content": "Hello World\nLine 2\nLine 3"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(!write_res.is_error);

    // Test Read
    let read_res = read_tool
        .execute(
            serde_json::json!({
                "path": "test.txt",
                "start_line": 1,
                "end_line": 2
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(!read_res.is_error);
    assert!(read_res.output.contains("Hello World"));

    // Test Edit
    let edit_res = edit_tool
        .execute(
            serde_json::json!({
                "path": "test.txt",
                "old_text": "Hello World",
                "new_text": "Hello Sparky"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(!edit_res.is_error);
    assert!(edit_res.output.contains("--- test.txt"));
    assert!(edit_res.output.contains("+++ test.txt"));
    assert!(edit_res.output.contains("-Hello World"));
    assert!(edit_res.output.contains("+Hello Sparky"));

    // Verify Read after edit
    let read_after = read_tool
        .execute(serde_json::json!({ "path": "test.txt" }), cwd)
        .await
        .unwrap();

    assert!(read_after.output.contains("Hello Sparky"));
}

#[tokio::test]
async fn test_ls_grep_find_tools() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();

    let write_tool = WriteTool;
    write_tool
        .execute(
            serde_json::json!({
                "path": "src/main.rs",
                "content": "fn main() {\n    println!(\"Sparky AI\");\n}"
            }),
            cwd,
        )
        .await
        .unwrap();

    let ls_tool = LsTool;
    let ls_res = ls_tool
        .execute(serde_json::json!({ "path": ".", "recursive": false }), cwd)
        .await
        .unwrap();

    assert!(!ls_res.is_error);
    assert!(ls_res.output.contains("src"));

    let grep_tool = GrepTool;
    let grep_res = grep_tool
        .execute(serde_json::json!({ "pattern": "Sparky AI" }), cwd)
        .await
        .unwrap();

    assert!(!grep_res.is_error);
    assert!(grep_res.output.contains("main.rs"));

    let find_tool = FindTool;
    let find_res = find_tool
        .execute(serde_json::json!({ "pattern": "*.rs" }), cwd)
        .await
        .unwrap();

    assert!(!find_res.is_error);
    assert!(find_res.output.contains("main.rs"));
}

#[tokio::test]
async fn all_file_tools_reject_paths_outside_the_working_directory() {
    let root = tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    std::fs::write(root.path().join("outside.txt"), "do not touch").unwrap();
    let cwd = workspace.to_str().unwrap();
    let read_tool = ReadTool::default();

    let cases: Vec<(&dyn Tool, serde_json::Value)> = vec![
        (&read_tool, serde_json::json!({ "path": "../outside.txt" })),
        (
            &WriteTool,
            serde_json::json!({ "path": "../created.txt", "content": "bad" }),
        ),
        (
            &EditTool,
            serde_json::json!({
                "path": "../outside.txt",
                "old_text": "do not",
                "new_text": "did"
            }),
        ),
        (
            &GrepTool,
            serde_json::json!({ "path": "..", "pattern": "do not" }),
        ),
        (
            &FindTool,
            serde_json::json!({ "path": "..", "pattern": "*" }),
        ),
        (&LsTool, serde_json::json!({ "path": ".." })),
    ];

    for (tool, args) in cases {
        let result = tool.execute(args, cwd).await.unwrap();
        assert!(
            result.is_error,
            "{} unexpectedly accepted traversal",
            tool.name()
        );
        assert!(
            result.output.contains("Path traversal detected"),
            "{} returned unexpected error: {}",
            tool.name(),
            result.output
        );
    }

    assert!(!root.path().join("created.txt").exists());
    assert_eq!(
        std::fs::read_to_string(root.path().join("outside.txt")).unwrap(),
        "do not touch"
    );
}

#[tokio::test]
async fn edit_rejects_ambiguous_matches_without_modifying_the_file() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    std::fs::write(dir.path().join("repeated.txt"), "same\nsame\n").unwrap();

    let result = EditTool
        .execute(
            serde_json::json!({
                "path": "repeated.txt",
                "old_text": "same",
                "new_text": "changed"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(result.is_error);
    assert!(result.output.contains("multiple occurrences"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("repeated.txt")).unwrap(),
        "same\nsame\n"
    );
}

#[tokio::test]
async fn edit_matches_read_normalized_text_in_crlf_files_and_preserves_crlf() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let path = dir.path().join("windows.txt");
    std::fs::write(&path, "first\r\nsecond\r\nthird\r\n").unwrap();

    let result = EditTool
        .execute(
            serde_json::json!({
                "path": "windows.txt",
                "old_text": "first\nsecond",
                "new_text": "first\nupdated"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(!result.is_error, "{}", result.output);
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "first\r\nupdated\r\nthird\r\n"
    );
}

#[tokio::test]
async fn edit_accepts_legacy_camel_case_text_arguments() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let path = dir.path().join("legacy.txt");
    std::fs::write(&path, "before\n").unwrap();

    let result = EditTool
        .execute(
            serde_json::json!({
                "path": "legacy.txt",
                "oldText": "before",
                "newText": "after"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(!result.is_error, "{}", result.output);
    assert_eq!(std::fs::read_to_string(path).unwrap(), "after\n");
}

#[tokio::test]
async fn edit_rejects_matches_that_are_ambiguous_across_line_endings() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let path = dir.path().join("mixed.txt");
    let original = "alpha\r\nbeta\nalpha\nbeta\n";
    std::fs::write(&path, original).unwrap();

    let result = EditTool
        .execute(
            serde_json::json!({
                "path": "mixed.txt",
                "old_text": "alpha\nbeta",
                "new_text": "changed"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(result.is_error);
    assert!(result.output.contains("multiple occurrences"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), original);
}

#[tokio::test]
async fn edit_rejects_an_empty_target_without_modifying_the_file() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    let path = dir.path().join("empty-target.txt");
    std::fs::write(&path, "unchanged").unwrap();

    let result = EditTool
        .execute(
            serde_json::json!({
                "path": "empty-target.txt",
                "old_text": "",
                "new_text": "bad"
            }),
            cwd,
        )
        .await
        .unwrap();

    assert!(result.is_error);
    assert!(result.output.contains("must not be empty"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "unchanged");
}

#[tokio::test]
async fn read_reports_line_ranges_beyond_end_of_file() {
    let dir = tempdir().unwrap();
    let cwd = dir.path().to_str().unwrap();
    std::fs::write(dir.path().join("short.txt"), "one\ntwo\n").unwrap();

    let result = ReadTool::default()
        .execute(
            serde_json::json!({ "path": "short.txt", "start_line": 10 }),
            cwd,
        )
        .await
        .unwrap();

    assert!(result.is_error);
    assert!(result.output.contains("exceeds total lines"));
}
