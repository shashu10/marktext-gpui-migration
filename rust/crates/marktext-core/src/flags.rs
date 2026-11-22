use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Rollout stage for an individual strangler-fig subsystem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MigrationMode {
    Legacy,
    Shadow,
    Migrated,
}

impl MigrationMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            MigrationMode::Legacy => "legacy",
            MigrationMode::Shadow => "shadow",
            MigrationMode::Migrated => "migrated",
        }
    }
}

/// Per-component routing configuration inside `config/migration-flags/<env>.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentFlag {
    pub mode: MigrationMode,
    pub engine: String,
    pub shadow_sample_rate: f64,
    pub fallback_on_error: bool,
}

/// Top-level environment migration flag file (`dev`, `staging`, or `prod`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MigrationFlags {
    pub environment: String,
    #[serde(default)]
    pub description: String,
    pub components: BTreeMap<String, ComponentFlag>,
}

impl MigrationFlags {
    /// Returns the configured mode for `component`, defaulting to `Legacy` if absent.
    pub fn mode_for(&self, component: &str) -> MigrationMode {
        self.components
            .get(component)
            .map(|c| c.mode)
            .unwrap_or(MigrationMode::Legacy)
    }

    /// Returns the configured engine name for `component`, defaulting to `"legacy-ts"`.
    pub fn engine_for<'a>(&'a self, component: &str) -> &'a str {
        self.components
            .get(component)
            .map(|c| c.engine.as_str())
            .unwrap_or("legacy-ts")
    }
}

/// Resolves the repository root by walking upwards from `start` until
/// `config/migration-flags` is found.
pub fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        if current.join("config").join("migration-flags").is_dir() {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

/// Loads `config/migration-flags/<env>.json`, searching from `repo_root` (if provided),
/// then current working directory ancestors, then compile-time manifest ancestors.
pub fn load_flags_for_env(env: &str, repo_root: Option<&Path>) -> Result<MigrationFlags, String> {
    let valid_env = match env {
        "dev" | "staging" | "prod" => env,
        other => {
            return Err(format!(
                "Invalid migration environment '{other}'. Expected one of: dev, staging, prod."
            ));
        }
    };

    let candidate_root = repo_root
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok().and_then(|d| find_repo_root(&d)))
        .or_else(|| find_repo_root(Path::new(env!("CARGO_MANIFEST_DIR"))));

    let root = candidate_root.ok_or_else(|| {
        "Unable to locate repository root containing config/migration-flags/".to_string()
    })?;

    let path = root
        .join("config")
        .join("migration-flags")
        .join(format!("{valid_env}.json"));

    load_flags_from_path(&path)
}

/// Loads a `MigrationFlags` JSON document directly from `path`.
pub fn load_flags_from_path(path: &Path) -> Result<MigrationFlags, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|err| format!("Failed to read flags file '{}': {err}", path.display()))?;
    serde_json::from_str::<MigrationFlags>(&raw)
        .map_err(|err| format!("Failed to parse flags file '{}': {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_all_three_environment_flag_files() {
        let dev = load_flags_for_env("dev", None).expect("load dev flags");
        assert_eq!(dev.environment, "dev");
        assert_eq!(dev.mode_for("word-count"), MigrationMode::Migrated);
        assert_eq!(dev.mode_for("outline-toc"), MigrationMode::Migrated);
        assert_eq!(dev.mode_for("markdown-blocks"), MigrationMode::Legacy);

        let staging = load_flags_for_env("staging", None).expect("load staging flags");
        assert_eq!(staging.environment, "staging");
        assert_eq!(staging.mode_for("word-count"), MigrationMode::Migrated);
        assert_eq!(staging.mode_for("outline-toc"), MigrationMode::Shadow);
        assert_eq!(staging.mode_for("markdown-blocks"), MigrationMode::Legacy);

        let prod = load_flags_for_env("prod", None).expect("load prod flags");
        assert_eq!(prod.environment, "prod");
        assert_eq!(prod.mode_for("word-count"), MigrationMode::Shadow);
        assert_eq!(prod.mode_for("outline-toc"), MigrationMode::Legacy);
        assert_eq!(prod.mode_for("markdown-blocks"), MigrationMode::Legacy);
    }

    #[test]
    fn rejects_unknown_environment() {
        assert!(load_flags_for_env("invalid", None).is_err());
    }
}
