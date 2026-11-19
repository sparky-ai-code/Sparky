use anyhow::{anyhow, Context, Result};
use std::path::{Component, Path, PathBuf};

const TRAVERSAL_ERROR: &str = "Path traversal detected: path escapes working directory";

fn canonical_cwd(cwd: &str) -> Result<PathBuf> {
    std::fs::canonicalize(cwd)
        .with_context(|| format!("Failed to canonicalize working directory: {cwd}"))
}

fn normalized_candidate(canonical_cwd: &Path, user_path: &str) -> Result<PathBuf> {
    let path = Path::new(user_path);
    if path.is_absolute() {
        return Ok(path.to_path_buf());
    }

    let mut candidate = canonical_cwd.to_path_buf();

    for component in Path::new(user_path).components() {
        match component {
            Component::CurDir => {}
            Component::Normal(part) => candidate.push(part),
            Component::ParentDir => {
                if candidate == canonical_cwd {
                    return Err(anyhow!(TRAVERSAL_ERROR));
                }
                candidate.pop();
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(anyhow!(TRAVERSAL_ERROR));
            }
        }
    }

    Ok(candidate)
}

fn ensure_contained(canonical_cwd: &Path, canonical_path: PathBuf) -> Result<PathBuf> {
    if canonical_path.starts_with(canonical_cwd) {
        Ok(canonical_path)
    } else {
        Err(anyhow!(TRAVERSAL_ERROR))
    }
}

pub(crate) fn canonicalize_existing(cwd: &str, user_path: &str) -> Result<PathBuf> {
    let canonical_cwd = canonical_cwd(cwd)?;
    let candidate = normalized_candidate(&canonical_cwd, user_path)?;
    let canonical_path = std::fs::canonicalize(&candidate)
        .with_context(|| format!("Failed to canonicalize path: {}", candidate.display()))?;

    if Path::new(user_path).is_absolute() {
        Ok(canonical_path)
    } else {
        ensure_contained(&canonical_cwd, canonical_path)
    }
}

pub(crate) fn resolve_write_path(cwd: &str, user_path: &str) -> Result<PathBuf> {
    let canonical_cwd = canonical_cwd(cwd)?;
    let candidate = normalized_candidate(&canonical_cwd, user_path)?;
    let allow_external = Path::new(user_path).is_absolute();

    if candidate.exists() {
        let canonical_path = std::fs::canonicalize(&candidate)
            .with_context(|| format!("Failed to canonicalize path: {}", candidate.display()))?;
        return if allow_external {
            Ok(canonical_path)
        } else {
            ensure_contained(&canonical_cwd, canonical_path)
        };
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow!("Write path has no parent directory"))?;
    let mut existing_ancestor = parent;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .ok_or_else(|| anyhow!(TRAVERSAL_ERROR))?;
    }

    let canonical_ancestor = std::fs::canonicalize(existing_ancestor).with_context(|| {
        format!(
            "Failed to canonicalize parent directory: {}",
            existing_ancestor.display()
        )
    })?;
    if allow_external {
        Ok(candidate)
    } else {
        ensure_contained(&canonical_cwd, canonical_ancestor)?;
        Ok(candidate)
    }
}

pub(crate) fn validate_created_parent(cwd: &str, path: &Path, allow_external: bool) -> Result<()> {
    let canonical_cwd = canonical_cwd(cwd)?;
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("Write path has no parent directory"))?;
    let canonical_parent = std::fs::canonicalize(parent).with_context(|| {
        format!(
            "Failed to canonicalize parent directory: {}",
            parent.display()
        )
    })?;
    if allow_external {
        Ok(())
    } else {
        ensure_contained(&canonical_cwd, canonical_parent).map(|_| ())
    }
}

pub(crate) fn should_skip_directory(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(
            ".git"
                | ".hg"
                | ".svn"
                | "target"
                | "node_modules"
                | "dist"
                | "build"
                | "release"
                | ".wrangler"
                | ".sparky"
        )
    )
}
