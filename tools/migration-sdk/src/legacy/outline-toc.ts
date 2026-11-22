import type { OutlineHeading } from '../types.js';

/**
 * Legacy MarkText Unicode-aware GitHub slug generator ported verbatim from:
 *   packages/muya/src/utils/slug.ts (issue #5292)
 */
export function generateGithubSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Legacy MarkText heading line scanner ported verbatim from:
 *   packages/desktop/src/renderer/src/util/sourceModeToc.ts#getMarkdownHeadingLines
 */
export function getMarkdownHeadingLines(markdown: string): number[] {
  return extractOutlineToc(markdown).map((entry) => entry.line);
}

/**
 * Extracts Markdown document outline headings (ATX & setext) skipping fenced
 * code blocks, matching MarkText's `getMarkdownHeadingLines` and `generateGithubSlug`:
 *   - packages/desktop/src/renderer/src/util/sourceModeToc.ts
 *   - packages/muya/src/utils/slug.ts
 */
export function extractOutlineToc(markdown: string): OutlineHeading[] {
  const result: OutlineHeading[] = [];
  const lines = markdown.split('\n');
  let fence: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1]?.[0] ?? null;
      if (marker !== null) {
        if (fence === null) fence = marker;
        else if (marker === fence) fence = null;
      }
      continue;
    }
    if (fence !== null) continue;

    const atxMatch = line.match(/^ {0,3}(#{1,6})(?:\s+(.*)|\s*$)/);
    if (atxMatch) {
      const level = atxMatch[1]?.length ?? 1;
      const rawText = atxMatch[2] ?? '';
      const text = rawText.replace(/\s+#+\s*$/, '').trim();
      result.push({
        line: i,
        level,
        text,
        githubSlug: generateGithubSlug(text),
      });
      continue;
    }

    const next = lines[i + 1];
    if (line.trim() !== '' && next !== undefined) {
      const setextMatch = next.match(/^ {0,3}(=+|-+)\s*$/);
      if (setextMatch) {
        const level = setextMatch[1]?.[0] === '=' ? 1 : 2;
        const text = line.trim();
        result.push({
          line: i,
          level,
          text,
          githubSlug: generateGithubSlug(text),
        });
        i++; // consume the underline line
      }
    }
  }

  return result;
}
