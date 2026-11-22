import type { MarkdownBlock } from '../types.js';

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_RE = /^ {0,3}(#{1,6})(?:\s+(.*)|\s*$)/;
const HR_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(=+|-+)\s*$/;
const TASK_ITEM_RE = /^ {0,3}[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BLOCKQUOTE_RE = /^ {0,3}>\s?(.*)$/;

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  if (line.trim() === '') return true;
  if (FENCE_OPEN_RE.test(line)) return true;
  if (ATX_HEADING_RE.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (TASK_ITEM_RE.test(line)) return true;
  if (BLOCKQUOTE_RE.test(line)) return true;

  const next = lines[index + 1];
  if (next !== undefined && SETEXT_UNDERLINE_RE.test(next)) {
    return true;
  }

  return false;
}

/**
 * Deterministic legacy TypeScript GFM block tokenizer.
 *
 * Serves as the legacy reference implementation (and strangler-fig fallback)
 * for the `markdown-blocks` migration target (`migrations/markdown-blocks.json`).
 *
 * Block grammar (in precedence order):
 * 1. Fenced code block: `^ {0,3}(`{3,}|~{3,})(.*)` closed by same char of >= length.
 * 2. ATX heading: `^ {0,3}(#{1,6})(?:\s+(.*)|\s*$)` stripping trailing `\s+#+\s*$`.
 * 3. Horizontal rule (`hr`): 3+ `-`, `*`, or `_` with optional spaces/tabs.
 * 4. Setext heading: non-empty line followed by `^ {0,3}(=+|-+)\s*$`.
 * 5. Task list item: `^ {0,3}[-*+]\s+\[([ xX])\]\s+(.*)$`.
 * 6. Blockquote: consecutive lines matching `^ {0,3}>\s?(.*)$` joined with `\n`.
 * 7. Paragraph: consecutive non-blank lines not starting any construct above.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  if (markdown.length === 0) {
    return [];
  }

  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: MarkdownBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (line.trim() === '') {
      i++;
      continue;
    }

    // 1. Fenced code block
    const fenceMatch = line.match(FENCE_OPEN_RE);
    if (fenceMatch) {
      const fenceSeq = fenceMatch[1] ?? '```';
      const fenceChar = fenceSeq[0] ?? '`';
      const fenceLen = fenceSeq.length;
      const lang = (fenceMatch[2] ?? '').trim();
      const closeRe = new RegExp(`^ {0,3}${fenceChar}{${fenceLen},}[ \\t]*$`);
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        const inner = lines[i] ?? '';
        if (closeRe.test(inner)) {
          i++;
          break;
        }
        codeLines.push(inner);
        i++;
      }
      blocks.push({
        kind: 'code_fence',
        lang,
        code: codeLines.join('\n'),
      });
      continue;
    }

    // 2. ATX heading
    const atxMatch = line.match(ATX_HEADING_RE);
    if (atxMatch) {
      const level = atxMatch[1]?.length ?? 1;
      const rawText = atxMatch[2] ?? '';
      const text = rawText.replace(/\s+#+\s*$/, '').trim();
      blocks.push({ kind: 'heading', level, text });
      i++;
      continue;
    }

    // 3. Horizontal rule (standalone)
    if (HR_RE.test(line)) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // 4. Task item
    const taskMatch = line.match(TASK_ITEM_RE);
    if (taskMatch) {
      const checked = (taskMatch[1] ?? ' ').toLowerCase() === 'x';
      const text = (taskMatch[2] ?? '').trim();
      blocks.push({ kind: 'task_item', checked, text });
      i++;
      continue;
    }

    // 5. Blockquote (group consecutive `>` lines)
    const bqMatch = line.match(BLOCKQUOTE_RE);
    if (bqMatch) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i] ?? '';
        const m = cur.match(BLOCKQUOTE_RE);
        if (!m) break;
        quoteLines.push(m[1] ?? '');
        i++;
      }
      blocks.push({
        kind: 'blockquote',
        text: quoteLines.join('\n').trim(),
      });
      continue;
    }

    // 6. Setext heading
    const next = lines[i + 1];
    if (next !== undefined) {
      const setextMatch = next.match(SETEXT_UNDERLINE_RE);
      if (setextMatch) {
        const level = setextMatch[1]?.[0] === '=' ? 1 : 2;
        blocks.push({
          kind: 'heading',
          level,
          text: line.trim(),
        });
        i += 2;
        continue;
      }
    }

    // 7. Paragraph
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines, i)) {
      paraLines.push(lines[i] ?? '');
      i++;
    }
    blocks.push({
      kind: 'paragraph',
      text: paraLines.join('\n').trim(),
    });
  }

  return blocks;
}
