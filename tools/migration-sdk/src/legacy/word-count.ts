import type { WordCountResult } from '../types.js';

/**
 * Legacy MarkText `wordCount` implementation ported verbatim from:
 *   packages/muya/src/utils/index.ts (lines 247-261)
 *
 * Preserves exact MarkText semantics:
 * - Paragraphs split on `/\n{2,}/`, filtering empty segments.
 * - CJK characters in `[\u4E00-\u9FA5]` each count as 1 word and 1 character,
 *   and are removed before splitting remaining text on `/\s+/`.
 * - `character` and `all` measure UTF-16 code units (`string.length`).
 */
export function wordCount(markdown: string): WordCountResult {
  const paragraph = markdown.split(/\n{2,}/).filter((line) => line).length;
  let word = 0;
  let character = 0;
  let all = 0;

  const removedChinese = markdown.replace(/[\u4E00-\u9FA5]/g, '');
  const tokens = removedChinese.split(/\s+/).filter((t) => t);
  const chineseWordLength = markdown.length - removedChinese.length;
  word += chineseWordLength + tokens.length;
  character += tokens.reduce((acc, t) => acc + t.length, 0) + chineseWordLength;
  all += markdown.length;

  return { word, paragraph, character, all };
}
