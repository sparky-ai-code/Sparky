use crate::types::{SessionEntry, SessionHeader, CURRENT_SESSION_VERSION};
use sparky_ai::{Message, Role};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use tokio::fs::{self, OpenOptions};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

pub type SharedSessionManager = Arc<AsyncMutex<SessionManager>>;

type SessionFileLock = Arc<AsyncMutex<()>>;
type WeakSessionFileLock = Weak<AsyncMutex<()>>;

fn session_locks() -> &'static StdMutex<HashMap<PathBuf, WeakSessionFileLock>> {
    static LOCKS: OnceLock<StdMutex<HashMap<PathBuf, WeakSessionFileLock>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn normalized_lock_path(path: &Path) -> PathBuf {
    if let Ok(canonical) = std::fs::canonicalize(path) {
        return canonical;
    }
    if let Some(parent) = path.parent() {
        if let Ok(canonical_parent) = std::fs::canonicalize(parent) {
            if let Some(file_name) = path.file_name() {
                return canonical_parent.join(file_name);
            }
        }
    }
    path.to_path_buf()
}

fn session_file_lock(path: &Path) -> SessionFileLock {
    let key = normalized_lock_path(path);
    let mut locks = session_locks()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }

    let lock = Arc::new(AsyncMutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}

/// Gitignore entries that should never be tracked (session files, runtime
/// data, etc. that change on every agent turn).
const GITIGNORE_ENTRIES: &[&str] = &["/.sparky/"];

/// Ensure session/runtime directories are listed in the project's `.gitignore`
/// so they don't randomly show up in git diffs when an agent turn writes
/// messages to disk. Runtime session loading must never mutate the user's Git
/// index; already-tracked files remain an explicit user operation.
async fn ensure_session_dirs_gitignored(cwd: &str) -> anyhow::Result<()> {
    let gitignore_path = Path::new(cwd).join(".gitignore");

    let content = match fs::read_to_string(&gitignore_path).await {
        Ok(content) => content,
        Err(_) if !gitignore_path.exists() => {
            // No .gitignore yet — create one with sparky entry.
            fs::write(&gitignore_path, format!("{}\n", GITIGNORE_ENTRIES[0])).await?;
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };

    let needs_entry = !content.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == GITIGNORE_ENTRIES[0]
            || trimmed == "/.sparky"
            || trimmed == ".sparky/"
            || trimmed == ".sparky"
    });

    if needs_entry {
        let mut file = OpenOptions::new()
            .append(true)
            .open(&gitignore_path)
            .await?;
        file.write_all(format!("{}\n", GITIGNORE_ENTRIES[0]).as_bytes())
            .await?;
        file.flush().await?;
    }

    Ok(())
}

pub struct SessionManager {
    session_file: PathBuf,
    header: SessionHeader,
    entries: Vec<SessionEntry>,
    by_id: HashMap<String, SessionEntry>,
    leaf_id: Option<String>,
    first_kept_entry_id: Option<String>,
    file_lock: SessionFileLock,
}

impl SessionManager {
    pub async fn create_new(cwd: &str, parent_session: Option<String>) -> anyhow::Result<Self> {
        let session_dir = Path::new(cwd).join(".sparky").join("sessions");
        fs::create_dir_all(&session_dir).await?;

        // Ensure session/runtime dirs are gitignored so they don't pollute diffs.
        let _ = ensure_session_dirs_gitignored(cwd).await;

        let id = Uuid::new_v4().to_string();
        let filename = format!("{}.jsonl", id);
        let session_file = session_dir.join(filename);
        let file_lock = session_file_lock(&session_file);

        let header = SessionHeader {
            r#type: "session".to_string(),
            version: CURRENT_SESSION_VERSION,
            id: id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            cwd: cwd.to_string(),
            parent_session,
        };

        {
            let _guard = file_lock.lock().await;
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&session_file)
                .await?;

            let header_str = serde_json::to_string(&header)?;
            file.write_all(format!("{}\n", header_str).as_bytes())
                .await?;
        }

        Ok(Self {
            session_file,
            header,
            entries: Vec::new(),
            by_id: HashMap::new(),
            leaf_id: None,
            first_kept_entry_id: None,
            file_lock,
        })
    }

    pub async fn load(cwd: &str, session_id: &str) -> anyhow::Result<Self> {
        let normalized_id = Uuid::parse_str(session_id)
            .map_err(|_| anyhow::anyhow!("Invalid Sparky session id"))?
            .to_string();

        // Ensure session/runtime dirs are gitignored so they don't pollute diffs.
        let _ = ensure_session_dirs_gitignored(cwd).await;
        let session_file = Path::new(cwd)
            .join(".sparky")
            .join("sessions")
            .join(format!("{}.jsonl", normalized_id));
        let file_lock = session_file_lock(&session_file);
        let (header, entries, by_id, leaf_id) = {
            let _guard = file_lock.lock().await;
            let file = fs::File::open(&session_file).await.map_err(|error| {
                anyhow::anyhow!(
                    "Unable to resume Sparky session '{}' from '{}': {}",
                    normalized_id,
                    session_file.display(),
                    error
                )
            })?;
            let mut lines = BufReader::new(file).lines();
            let header_line = lines
                .next_line()
                .await?
                .ok_or_else(|| anyhow::anyhow!("Sparky session file is empty"))?;
            let header: SessionHeader = serde_json::from_str(&header_line)?;
            anyhow::ensure!(header.r#type == "session", "Invalid Sparky session header");
            anyhow::ensure!(
                header.version <= CURRENT_SESSION_VERSION,
                "Sparky session version {} is newer than supported version {}",
                header.version,
                CURRENT_SESSION_VERSION
            );
            anyhow::ensure!(
                header.id == normalized_id,
                "Sparky session header id does not match its filename"
            );

            let mut entries = Vec::new();
            let mut by_id = HashMap::new();
            let mut leaf_id = None;
            let mut line_number = 1usize;
            while let Some(line) = lines.next_line().await? {
                line_number += 1;
                if line.trim().is_empty() {
                    continue;
                }
                let entry: SessionEntry = serde_json::from_str(&line).map_err(|error| {
                    anyhow::anyhow!(
                        "Invalid entry on line {} of Sparky session '{}': {}",
                        line_number,
                        normalized_id,
                        error
                    )
                })?;
                leaf_id = Some(entry.id().to_string());
                by_id.insert(entry.id().to_string(), entry.clone());
                entries.push(entry);
            }
            (header, entries, by_id, leaf_id)
        };

        let first_kept_entry_id = entries.iter().rev().find_map(|entry| match entry {
            SessionEntry::Compaction {
                first_kept_entry_id,
                ..
            } => Some(first_kept_entry_id.clone()),
            _ => None,
        });

        let mut manager = Self {
            session_file,
            header,
            entries,
            by_id,
            leaf_id,
            first_kept_entry_id: first_kept_entry_id.clone(),
            file_lock,
        };

        if let Some(first_kept_entry_id) = first_kept_entry_id {
            manager.trim_entries_before(&first_kept_entry_id)?;
        }

        Ok(manager)
    }

    pub async fn append_entry(&mut self, entry: SessionEntry) -> anyhow::Result<()> {
        let line = format!("{}\n", serde_json::to_string(&entry)?);
        let file_lock = Arc::clone(&self.file_lock);
        let _guard = file_lock.lock().await;
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.session_file)
            .await?;

        file.write_all(line.as_bytes()).await?;
        file.flush().await?;
        if let SessionEntry::Compaction {
            first_kept_entry_id,
            ..
        } = &entry
        {
            self.first_kept_entry_id = Some(first_kept_entry_id.clone());
        }
        self.leaf_id = Some(entry.id().to_string());
        self.by_id.insert(entry.id().to_string(), entry.clone());
        self.entries.push(entry);
        Ok(())
    }

    pub async fn append_message(&mut self, message: Message) -> anyhow::Result<String> {
        let entry_id = Uuid::new_v4().to_string();
        let entry = SessionEntry::Message {
            id: entry_id.clone(),
            parent_id: self.leaf_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            message,
        };
        self.append_entry(entry).await?;
        Ok(entry_id)
    }

    pub fn build_context_messages(&self) -> Vec<Message> {
        if let Some(first_kept_entry_id) = self.first_kept_entry_id.as_deref() {
            return Self::repair_tool_protocol(self.build_compacted_context(first_kept_entry_id));
        }

        let mut messages = Vec::new();

        // Trace leaf back to root
        let mut path_entries = Vec::new();
        let mut curr_id = self.leaf_id.as_deref();

        while let Some(id) = curr_id {
            if let Some(entry) = self.by_id.get(id) {
                path_entries.push(entry);
                curr_id = entry.parent_id();
            } else {
                break;
            }
        }

        path_entries.reverse();

        for entry in path_entries {
            match entry {
                SessionEntry::Message { message, .. } => {
                    messages.push(message.clone());
                }
                SessionEntry::CustomMessage { content, .. } => {
                    messages.push(Message::user(content.clone()));
                }
                SessionEntry::Compaction { summary, .. } => {
                    messages.push(Message::system(format!(
                        "[Compaction Summary]: {}",
                        summary
                    )));
                }
            }
        }

        Self::repair_tool_protocol(messages)
    }

    /// Build only the history that will be replaced by a compaction entry.
    /// Keeping the recent suffix out of the summarizer avoids sending the same
    /// large context twice and leaves more room for the summary request itself.
    pub fn build_compaction_messages(&self, first_kept_entry_id: &str) -> Vec<Message> {
        let Some(first_kept_index) = self
            .entries
            .iter()
            .position(|entry| entry.id() == first_kept_entry_id)
        else {
            return Vec::new();
        };

        let mut messages = Vec::new();
        if let Some(summary) = self.entries.iter().rev().find_map(|entry| match entry {
            SessionEntry::Compaction { summary, .. } => Some(summary),
            _ => None,
        }) {
            messages.push(Message::system(format!(
                "[Previous Compaction Summary]: {}",
                summary
            )));
        }
        for entry in &self.entries[..first_kept_index] {
            Self::push_entry_message(&mut messages, entry);
        }
        Self::repair_tool_protocol(messages)
    }

    /// Provider APIs require every assistant tool call to be followed by one
    /// matching tool result before another user/assistant message. A killed
    /// Sparky process can leave the durable transcript between those writes.
    /// Repair that wire-level invariant when rebuilding context so interrupted
    /// sessions remain resumable without rewriting their audit log.
    fn repair_tool_protocol(messages: Vec<Message>) -> Vec<Message> {
        const INTERRUPTED_TOOL_RESULT: &str =
            "Tool execution was interrupted before a result was recorded. Do not assume the tool completed; retry it if it is still needed.";

        fn flush_missing(output: &mut Vec<Message>, pending: &mut Vec<String>) {
            for tool_call_id in pending.drain(..) {
                output.push(Message::tool_result(
                    tool_call_id,
                    INTERRUPTED_TOOL_RESULT,
                    true,
                ));
            }
        }

        let mut repaired = Vec::with_capacity(messages.len());
        let mut pending_tool_calls = Vec::<String>::new();

        for message in messages {
            match &message.role {
                Role::Tool => {
                    let Some(result) = message.tool_result.as_ref() else {
                        // A tool-role message without a structured result is not
                        // valid provider history and cannot satisfy any call.
                        continue;
                    };
                    if let Some(index) = pending_tool_calls
                        .iter()
                        .position(|id| id == &result.tool_call_id)
                    {
                        pending_tool_calls.remove(index);
                        repaired.push(message);
                    }
                    // Drop orphan/duplicate tool results: upstream providers
                    // reject them just as they reject missing results.
                }
                Role::Assistant => {
                    flush_missing(&mut repaired, &mut pending_tool_calls);
                    pending_tool_calls = message
                        .tool_calls
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .map(|call| call.id.clone())
                        .collect();
                    repaired.push(message);
                }
                _ => {
                    flush_missing(&mut repaired, &mut pending_tool_calls);
                    repaired.push(message);
                }
            }
        }

        flush_missing(&mut repaired, &mut pending_tool_calls);
        repaired
    }

    fn build_compacted_context(&self, first_kept_entry_id: &str) -> Vec<Message> {
        let mut messages = Vec::new();
        let Some(first_kept_index) = self
            .entries
            .iter()
            .position(|entry| entry.id() == first_kept_entry_id)
        else {
            return messages;
        };

        if let Some(summary) = self.entries.iter().rev().find_map(|entry| match entry {
            SessionEntry::Compaction { summary, .. } => Some(summary),
            _ => None,
        }) {
            messages.push(Message::system(format!(
                "[Compaction Summary]: {}",
                summary
            )));
        }

        for entry in &self.entries[first_kept_index..] {
            Self::push_entry_message(&mut messages, entry);
        }

        messages
    }

    fn push_entry_message(messages: &mut Vec<Message>, entry: &SessionEntry) {
        match entry {
            SessionEntry::Message { message, .. } => messages.push(message.clone()),
            SessionEntry::CustomMessage { content, .. } => {
                messages.push(Message::user(content.clone()));
            }
            SessionEntry::Compaction { .. } => {}
        }
    }

    pub fn first_entry_id_for_recent_tokens(&self, max_tokens: usize) -> Option<String> {
        let mut estimated_tokens = 0;
        let mut first_kept_entry_id = None;

        for entry in self.entries.iter().rev() {
            let message = match entry {
                SessionEntry::Message { message, .. } => message,
                _ => continue,
            };

            first_kept_entry_id = Some(entry.id().to_string());
            estimated_tokens += message.estimated_tokens();
            if estimated_tokens >= max_tokens {
                break;
            }
        }

        first_kept_entry_id
    }

    pub fn trim_entries_before(&mut self, first_kept_entry_id: &str) -> anyhow::Result<usize> {
        let first_kept_index = self
            .entries
            .iter()
            .position(|entry| entry.id() == first_kept_entry_id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Cannot trim session: first kept entry '{}' was not found",
                    first_kept_entry_id
                )
            })?;

        let removed_entries: Vec<_> = self.entries.drain(..first_kept_index).collect();
        for entry in &removed_entries {
            self.by_id.remove(entry.id());
        }
        self.first_kept_entry_id = Some(first_kept_entry_id.to_string());

        Ok(removed_entries.len())
    }

    pub fn entry_count(&self) -> usize {
        self.entries.len()
    }

    pub fn session_file(&self) -> &Path {
        &self.session_file
    }

    pub fn session_id(&self) -> &str {
        &self.header.id
    }

    pub async fn save(&self) -> anyhow::Result<()> {
        let file_lock = Arc::clone(&self.file_lock);
        let _guard = file_lock.lock().await;
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.session_file)
            .await?;
        file.sync_all().await?;
        Ok(())
    }

    pub async fn rewrite_session_file(&self) -> anyhow::Result<()> {
        let file_lock = Arc::clone(&self.file_lock);
        let _guard = file_lock.lock().await;
        let mut file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.session_file)
            .await?;
        file.write_all(format!("{}\n", serde_json::to_string(&self.header)?).as_bytes())
            .await?;
        for entry in &self.entries {
            file.write_all(format!("{}\n", serde_json::to_string(entry)?).as_bytes())
                .await?;
        }
        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }

    pub fn into_shared(self) -> SharedSessionManager {
        Arc::new(AsyncMutex::new(self))
    }
}
