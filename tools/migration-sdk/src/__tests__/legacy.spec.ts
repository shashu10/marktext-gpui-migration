import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseMarkdownBlocks } from '../legacy/markdown-blocks.js';
import {
  extractOutlineToc,
  generateGithubSlug,
  getMarkdownHeadingLines,
} from '../legacy/outline-toc.js';
import { wordCount } from '../legacy/word-count.js';
import { resolveRepoRoot } from '../paths.js';

describe('legacy wordCount (MarkText packages/muya/src/utils/index.ts parity)', () => {
  it('counts plain ASCII words', () => {
    expect(wordCount('hello world')).toEqual({
      word: 2,
      character: 10,
      paragraph: 1,
      all: 11,
    });
  });

  it('counts each CJK character as its own word', () => {
    const result = wordCount('你好 world');
    expect(result).toEqual({
      word: 3,
      character: 7,
      paragraph: 1,
      all: 8,
    });
  });

  it('splits paragraphs on blank lines', () => {
    const result = wordCount('a\n\nb\n\nc');
    expect(result).toEqual({
      paragraph: 3,
      word: 3,
      character: 3,
      all: 7,
    });
  });

  it('returns all zeros for the empty string', () => {
    expect(wordCount('')).toEqual({
      word: 0,
      character: 0,
      paragraph: 0,
      all: 0,
    });
  });

  it('matches UTF-16 code-unit length for emoji surrogate pairs', () => {
    // 🚀 and 🔥 are each 2 UTF-16 code units in JS
    expect(wordCount('hi 🚀🔥')).toEqual({
      word: 2,
      paragraph: 1,
      character: 6,
      all: 7,
    });
  });

  it('handles mixed CJK inside ASCII tokens without splitting the ASCII token', () => {
    expect(wordCount('hello世界world')).toEqual({
      word: 3,
      paragraph: 1,
      character: 12,
      all: 12,
    });
  });
});

describe('legacy outlineToc & generateGithubSlug (MarkText sourceModeToc.ts + slug.ts)', () => {
  it('finds ATX and setext heading lines in document order', () => {
    const doc = [
      '# First', // 0
      '', // 1
      'text', // 2
      '', // 3
      '## Second', // 4
      '', // 5
      'Setext', // 6
      '------', // 7
      '', // 8
      '### Third', // 9
    ].join('\n');

    expect(getMarkdownHeadingLines(doc)).toEqual([0, 4, 6, 9]);
    expect(extractOutlineToc(doc)).toEqual([
      { line: 0, level: 1, text: 'First', githubSlug: 'first' },
      { line: 4, level: 2, text: 'Second', githubSlug: 'second' },
      { line: 6, level: 2, text: 'Setext', githubSlug: 'setext' },
      { line: 9, level: 3, text: 'Third', githubSlug: 'third' },
    ]);
  });

  it('ignores ATX and setext headings inside backtick and tilde fenced code blocks', () => {
    const fenced = [
      '# Real', // 0
      '', // 1
      '```', // 2
      '# not a heading', // 3
      'fake setext', // 4
      '---', // 5
      '```', // 6
      '~~~rust', // 7
      '## tilde ignored', // 8
      '~~~', // 9
      '## AlsoReal ###', // 10
    ].join('\n');

    expect(extractOutlineToc(fenced)).toEqual([
      { line: 0, level: 1, text: 'Real', githubSlug: 'real' },
      { line: 10, level: 2, text: 'AlsoReal', githubSlug: 'alsoreal' },
    ]);
  });

  it('generates Unicode-aware GitHub slugs for CJK and accented characters (#5292)', () => {
    expect(generateGithubSlug('多语言文档测试 — CJK & Accented Slugs (#5292)')).toBe(
      '多语言文档测试-cjk-accented-slugs-5292',
    );
    expect(generateGithubSlug('Café Résumé & Naïve Parsing')).toBe(
      'café-résumé-naïve-parsing',
    );
    expect(generateGithubSlug('日本語の見出しテスト 2026')).toBe('日本語の見出しテスト-2026');
    expect(generateGithubSlug('snake_case & dashed---title')).toBe('snake_case-dashed-title');
  });

  it('matches expected outline on evals/corpus/01-enterprise-spec.md', () => {
    const corpusPath = path.join(resolveRepoRoot(), 'evals', 'corpus', '01-enterprise-spec.md');
    const md = fs.readFileSync(corpusPath, 'utf8');
    const outline = extractOutlineToc(md).map((e) => [e.line, e.level, e.text]);
    expect(outline).toEqual([
      [0, 1, 'Enterprise Architecture Runbook'],
      [4, 2, 'Executive Summary'],
      [12, 3, 'Code Fence Trap (Must Not Appear in Outline)'],
      [29, 1, 'Legacy Setext Section'],
      [34, 2, 'Subsection Under Setext'],
      [39, 2, 'Rollout Checklist'],
    ]);
  });
});

describe('legacy parseMarkdownBlocks (reference tokenizer for markdown-blocks migration)', () => {
  it('returns empty array for empty input', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
  });

  it('parses headings, code fences, task items, blockquotes, hr, and paragraphs', () => {
    const md = [
      '# Title ###',
      '',
      'Intro paragraph line 1',
      'Intro paragraph line 2',
      '',
      '- [x] Completed task',
      '- [ ] Pending task',
      '',
      '```rust',
      'fn main() {}',
      '```',
      '',
      '> Quote line 1',
      '> Quote line 2',
      '',
      'Setext Heading',
      '==============',
      '',
      '---',
    ].join('\n');

    expect(parseMarkdownBlocks(md)).toEqual([
      { kind: 'heading', level: 1, text: 'Title' },
      { kind: 'paragraph', text: 'Intro paragraph line 1\nIntro paragraph line 2' },
      { kind: 'task_item', checked: true, text: 'Completed task' },
      { kind: 'task_item', checked: false, text: 'Pending task' },
      { kind: 'code_fence', lang: 'rust', code: 'fn main() {}' },
      { kind: 'blockquote', text: 'Quote line 1\nQuote line 2' },
      { kind: 'heading', level: 1, text: 'Setext Heading' },
      { kind: 'hr' },
    ]);
  });
});
