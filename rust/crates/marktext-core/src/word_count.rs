use serde::{Deserialize, Serialize};

/// Document statistics matching MarkText's `wordCount` in `packages/muya/src/utils/index.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCount {
    pub word: usize,
    pub paragraph: usize,
    pub character: usize,
    pub all: usize,
}

/// Exact ECMAScript `\s` (WhiteSpace + LineTerminator) predicate so splitting on `\s+`
/// matches V8/Node.js identically across Unicode code points (including `\uFEFF`, excluding `\u0085`).
#[inline]
fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// Counts non-empty segments produced by splitting `markdown` on `/\n{2,}/`.
#[inline]
fn count_paragraphs(markdown: &str) -> usize {
    let bytes = markdown.as_bytes();
    let len = bytes.len();
    let mut paragraphs = 0usize;
    let mut segment_start = 0usize;
    let mut i = 0usize;

    while i < len {
        if bytes[i] == b'\n' {
            let run_start = i;
            while i < len && bytes[i] == b'\n' {
                i += 1;
            }
            if i - run_start >= 2 {
                if run_start > segment_start {
                    paragraphs += 1;
                }
                segment_start = i;
            }
        } else {
            i += 1;
        }
    }

    if len > segment_start {
        paragraphs += 1;
    }

    paragraphs
}

/// Computes MarkText-compatible word, paragraph, character, and total UTF-16 length counts.
///
/// Matches `packages/muya/src/utils/index.ts#wordCount` byte-for-byte:
/// - `paragraph`: non-empty segments when splitting on `\n{2,}`
/// - CJK range `[\u4E00-\u9FA5]` counted individually and removed prior to `\s+` tokenization
/// - `word`: `chinese_word_length + tokens.len()`
/// - `character`: sum of UTF-16 code units of non-whitespace tokens + `chinese_word_length`
/// - `all`: total UTF-16 code units of `markdown` (matching JS `markdown.length`)
pub fn word_count(markdown: &str) -> WordCount {
    let paragraph = count_paragraphs(markdown);

    let mut chinese_word_length = 0usize;
    let mut token_count = 0usize;
    let mut token_utf16_chars = 0usize;
    let mut all = 0usize;
    let mut in_token = false;

    for c in markdown.chars() {
        let utf16_len = c.len_utf16();
        all += utf16_len;

        if ('\u{4E00}'..='\u{9FA5}').contains(&c) {
            chinese_word_length += 1;
            // Removing CJK chars before whitespace tokenization means CJK chars do not break
            // an in-progress non-CJK token.
            continue;
        }

        if is_js_whitespace(c) {
            in_token = false;
        } else {
            if !in_token {
                token_count += 1;
                in_token = true;
            }
            token_utf16_chars += utf16_len;
        }
    }

    WordCount {
        word: chinese_word_length + token_count,
        paragraph,
        character: token_utf16_chars + chinese_word_length,
        all,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input() {
        assert_eq!(
            word_count(""),
            WordCount {
                word: 0,
                paragraph: 0,
                character: 0,
                all: 0,
            }
        );
    }

    #[test]
    fn ascii_paragraphs_and_words() {
        let md = "Hello world\n\nSecond paragraph here.\n\n\nThird";
        assert_eq!(
            word_count(md),
            WordCount {
                word: 6,
                paragraph: 3,
                character: 35,
                all: md.encode_utf16().count(),
            }
        );
    }

    #[test]
    fn cjk_and_mixed_tokens() {
        // Removing CJK from "hello世界world" leaves "helloworld" (1 token, 10 chars) + 2 CJK chars.
        let md = "hello世界world";
        assert_eq!(
            word_count(md),
            WordCount {
                word: 3,
                paragraph: 1,
                character: 12,
                all: 12,
            }
        );
    }

    #[test]
    fn emoji_utf16_parity() {
        // Each of 🚀 and 🔥 is 2 UTF-16 code units (surrogate pair) in JS.
        let md = "hi 🚀🔥";
        assert_eq!(
            word_count(md),
            WordCount {
                word: 2,
                paragraph: 1,
                character: 6, // "hi" (2) + "🚀🔥" (4)
                all: 7,       // "hi " (3) + "🚀🔥" (4)
            }
        );
    }

    #[test]
    fn blank_lines_only() {
        assert_eq!(
            word_count("\n\n\n"),
            WordCount {
                word: 0,
                paragraph: 0,
                character: 0,
                all: 3,
            }
        );
        // Single newline does not match /\n{2,}/, so split yields ["\n"] (non-empty -> 1 paragraph).
        assert_eq!(
            word_count("\n"),
            WordCount {
                word: 0,
                paragraph: 1,
                character: 0,
                all: 1,
            }
        );
    }

    #[test]
    fn matches_enterprise_spec_corpus() {
        let corpus_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../evals/corpus/01-enterprise-spec.md"
        );
        let md = std::fs::read_to_string(corpus_path).expect("read 01-enterprise-spec.md");
        assert_eq!(
            word_count(&md),
            WordCount {
                word: 184,
                paragraph: 14,
                character: 1160,
                all: 1361,
            }
        );
    }
}
