use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

/// A single heading entry extracted from a Markdown document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TocEntry {
    pub line: usize,
    pub level: u8,
    pub text: String,
    #[serde(rename = "githubSlug")]
    pub github_slug: String,
}

fn fence_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(`{3,}|~{3,})").expect("valid fence regex"))
}

fn atx_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(#{1,6})(?:\s+(.*)|\s*$)").expect("valid atx regex"))
}

fn trailing_hashes_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+#+\s*$").expect("valid trailing hashes regex"))
}

fn setext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^ {0,3}(=+|-+)\s*$").expect("valid setext regex"))
}

fn slug_strip_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"[^\p{L}\p{M}\p{N}\p{Pc}\s-]").expect("valid unicode slug strip regex")
    })
}

fn slug_ws_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\s+").expect("valid whitespace regex"))
}

fn slug_dash_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"-+").expect("valid dash collapse regex"))
}

/// Exact port of `generateGithubSlug` in `packages/muya/src/utils/slug.ts` (issue #5292).
///
/// 1. `text.trim().to_lowercase()`
/// 2. Remove characters not matching `[\p{L}\p{M}\p{N}\p{Pc}\s-]`
/// 3. Replace `\s+` with `-`
/// 4. Collapse `-+` to `-`
pub fn github_slug(text: &str) -> String {
    let lower = text.trim().to_lowercase();
    let stripped = slug_strip_re().replace_all(&lower, "");
    let hyphenated = slug_ws_re().replace_all(&stripped, "-");
    slug_dash_re().replace_all(&hyphenated, "-").into_owned()
}

/// Extracts Markdown headings (ATX & setext) skipping fenced code blocks,
/// matching MarkText's `getMarkdownHeadingLines` in
/// `packages/desktop/src/renderer/src/util/sourceModeToc.ts`.
pub fn extract_outline(markdown: &str) -> Vec<TocEntry> {
    let lines: Vec<&str> = markdown.split('\n').collect();
    let mut entries = Vec::new();
    let mut fence: Option<char> = None;

    let fence_regex = fence_re();
    let atx_regex = atx_re();
    let trailing_hashes = trailing_hashes_re();
    let setext_regex = setext_re();

    let mut i = 0usize;
    while i < lines.len() {
        let line = lines[i];
        let trimmed_up_to_3 = strip_up_to_3_spaces(line);
        let first_byte = trimmed_up_to_3.as_bytes().first().copied();

        if matches!(first_byte, Some(b'`' | b'~')) {
            if let Some(caps) = fence_regex.captures(line) {
                if let Some(marker) = caps.get(1).and_then(|m| m.as_str().chars().next()) {
                    match fence {
                        None => fence = Some(marker),
                        Some(active) if active == marker => fence = None,
                        Some(_) => {}
                    }
                }
                i += 1;
                continue;
            }
        }

        if fence.is_some() {
            i += 1;
            continue;
        }

        if first_byte == Some(b'#') {
            if let Some(caps) = atx_regex.captures(line) {
                let level = caps.get(1).map(|m| m.as_str().len() as u8).unwrap_or(1);
                let raw_text = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let cleaned = trailing_hashes.replace(raw_text, "");
                let text = cleaned.trim().to_string();
                let slug = github_slug(&text);
                entries.push(TocEntry {
                    line: i,
                    level,
                    text,
                    github_slug: slug,
                });
                i += 1;
                continue;
            }
        }

        if let Some(next) = lines.get(i + 1) {
            let next_first = strip_up_to_3_spaces(next).as_bytes().first().copied();
            if matches!(next_first, Some(b'=' | b'-')) && !line.trim().is_empty() {
                if let Some(caps) = setext_regex.captures(next) {
                    let level = if caps
                        .get(1)
                        .map(|m| m.as_str().starts_with('='))
                        .unwrap_or(false)
                    {
                        1
                    } else {
                        2
                    };
                    let text = line.trim().to_string();
                    let slug = github_slug(&text);
                    entries.push(TocEntry {
                        line: i,
                        level,
                        text,
                        github_slug: slug,
                    });
                    i += 2; // consume the underline line
                    continue;
                }
            }
        }

        i += 1;
    }

    entries
}

#[inline]
fn strip_up_to_3_spaces(s: &str) -> &str {
    let bytes = s.as_bytes();
    let mut n = 0;
    while n < 3 && n < bytes.len() && bytes[n] == b' ' {
        n += 1;
    }
    &s[n..]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_github_slugs() {
        assert_eq!(
            github_slug("多语言文档测试 — CJK & Accented Slugs (#5292)"),
            "多语言文档测试-cjk-accented-slugs-5292"
        );
        assert_eq!(
            github_slug("Café Résumé & Naïve Parsing"),
            "café-résumé-naïve-parsing"
        );
        assert_eq!(
            github_slug("日本語の見出しテスト 2026"),
            "日本語の見出しテスト-2026"
        );
        assert_eq!(github_slug("snake_case & dashed---title"), "snake_case-dashed-title");
    }

    #[test]
    fn skips_fenced_blocks_and_parses_atx_and_setext() {
        let md = "\
# Main Title
```md
# Ignored Heading
Fake Setext
===========
```
~~~rust
## Also Ignored
~~~
   ### Indented 3 Spaces ###
    # Indented 4 Spaces Not Heading
##NoSpaceNotHeading

Setext H1
=========

Setext H2
---------
";
        let outline = extract_outline(md);
        assert_eq!(outline.len(), 4);
        assert_eq!(outline[0], TocEntry {
            line: 0,
            level: 1,
            text: "Main Title".into(),
            github_slug: "main-title".into(),
        });
        assert_eq!(outline[1], TocEntry {
            line: 9,
            level: 3,
            text: "Indented 3 Spaces".into(),
            github_slug: "indented-3-spaces".into(),
        });
        assert_eq!(outline[2], TocEntry {
            line: 13,
            level: 1,
            text: "Setext H1".into(),
            github_slug: "setext-h1".into(),
        });
        assert_eq!(outline[3], TocEntry {
            line: 16,
            level: 2,
            text: "Setext H2".into(),
            github_slug: "setext-h2".into(),
        });
    }

    #[test]
    fn parses_enterprise_spec_corpus() {
        let corpus_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../evals/corpus/01-enterprise-spec.md"
        );
        let md = std::fs::read_to_string(corpus_path).expect("read 01-enterprise-spec.md");
        let outline = extract_outline(&md);

        let summary: Vec<(usize, u8, &str)> = outline
            .iter()
            .map(|e| (e.line, e.level, e.text.as_str()))
            .collect();

        assert_eq!(
            summary,
            vec![
                (0, 1, "Enterprise Architecture Runbook"),
                (4, 2, "Executive Summary"),
                (12, 3, "Code Fence Trap (Must Not Appear in Outline)"),
                (29, 1, "Legacy Setext Section"),
                (34, 2, "Subsection Under Setext"),
                (39, 2, "Rollout Checklist"),
            ]
        );
    }
}
