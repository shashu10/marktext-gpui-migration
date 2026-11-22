use serde::{Deserialize, Serialize};
use std::fmt;

/// Target AST block contract for the `markdown-blocks` subsystem migration.
///
/// This enum mirrors `tools/migration-sdk/src/legacy/markdown-blocks.ts` so a
/// Cursor Cloud Agent can implement `parse_blocks` against an explicit,
/// strongly-typed contract and verify exact JSON parity across `evals/corpus/`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MarkdownBlock {
    Heading { level: u8, text: String },
    CodeFence { lang: String, code: String },
    TaskItem { checked: bool, text: String },
    Blockquote { text: String },
    Hr,
    Paragraph { text: String },
}

/// Error returned when a component has not yet been migrated to Rust and must
/// remain routed to the legacy TypeScript implementation per feature flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotMigratedError {
    pub component: &'static str,
}

impl NotMigratedError {
    pub const fn new(component: &'static str) -> Self {
        Self { component }
    }
}

impl fmt::Display for NotMigratedError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "Component '{}' is not yet migrated to Rust. Routed to legacy-ts per feature flags.",
            self.component
        )
    }
}

impl std::error::Error for NotMigratedError {}

/// Intentionally unmigrated stub for the Cloud Agent migration demo target.
pub fn parse_blocks(_markdown: &str) -> Result<Vec<MarkdownBlock>, String> {
    Err(NotMigratedError::new("markdown-blocks").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_not_migrated_error() {
        let err = parse_blocks("# Hello").unwrap_err();
        assert_eq!(
            err,
            "Component 'markdown-blocks' is not yet migrated to Rust. Routed to legacy-ts per feature flags."
        );
    }

    #[test]
    fn serializes_tagged_block_contract() {
        let block = MarkdownBlock::TaskItem {
            checked: true,
            text: "Migrate word-count".to_string(),
        };
        let json = serde_json::to_value(&block).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "kind": "task_item",
                "checked": true,
                "text": "Migrate word-count"
            })
        );

        let hr = serde_json::to_value(MarkdownBlock::Hr).expect("serialize hr");
        assert_eq!(hr, serde_json::json!({ "kind": "hr" }));
    }
}
