import { describe, expect, it } from 'vitest';
import { buildMigrationPrompt, normalizeRepoUrl } from '../dispatch.js';
import { loadAllEnvironmentFlags, deepCompare } from '../flags.js';
import { loadMigrationSpec } from '../paths.js';
import { runSdkQaReviewer, SdkStartupError } from '../qa/sdk-reviewer.js';
import {
  formatFlagsMatrixTerminal,
  formatQaScorecardMarkdown,
  formatQaScorecardTerminal,
} from '../report.js';
import type { QaDeterministicReport } from '../types.js';

const SAMPLE_REPORT: QaDeterministicReport = {
  timestamp: '2026-11-22T00:00:00.000Z',
  componentId: 'outline-toc',
  specTitle: 'Markdown Document Outline / TOC & GitHub Slug Extractor',
  changedFiles: ['rust/crates/marktext-core/src/outline_toc.rs'],
  parity: {
    totalFiles: 5,
    matchedFiles: 5,
    mismatchedFiles: 0,
    parityPercent: 100,
    exactMatch: true,
    files: [
      {
        file: '01-enterprise-spec.md',
        bytes: 1200,
        match: true,
        legacyMetrics: { iterations: 40, p50Ms: 0.12, p95Ms: 0.2, meanMs: 0.13, peakRssKb: 70000 },
        rustMetrics: { iterations: 40, p50Ms: 0.02, p95Ms: 0.04, meanMs: 0.02, peakRssKb: 4200 },
        speedupP50: 6.0,
        speedupP95: 5.0,
      },
    ],
  },
  benchmark: {
    benchmarkFile: '05-large-benchmark.md',
    iterations: 150,
    legacyP50Ms: 5.4,
    legacyP95Ms: 7.2,
    legacyMeanMs: 5.6,
    legacyPeakRssKb: 75000,
    rustP50Ms: 0.3,
    rustP95Ms: 0.45,
    rustMeanMs: 0.32,
    rustPeakRssKb: 4300,
    speedupP50: 18.0,
    speedupP95: 16.0,
    rssReductionRatio: 17.44,
    rustBinarySizeKb: 1600,
  },
  policies: [
    {
      ruleId: 'no-prod-flag-mutation',
      passed: true,
      severity: 'HARD_BLOCK',
      message: 'Production feature flags untouched.',
    },
  ],
  passed: true,
  durationMs: 312,
};

describe('dispatch helpers, report formatters, and SDK reviewer fallback', () => {
  it('normalizes shorthand owner/repo and full URLs cleanly', () => {
    expect(normalizeRepoUrl('org/marktext-gpui')).toBe('https://github.com/org/marktext-gpui');
    expect(normalizeRepoUrl('https://github.com/org/repo')).toBe('https://github.com/org/repo');
    expect(normalizeRepoUrl('github.com/org/repo.git')).toBe('https://github.com/org/repo');
  });

  it('builds a bounded migration prompt citing legacy source, allowedPaths, and forbiddenPaths', () => {
    const spec = loadMigrationSpec('markdown-blocks');
    const prompt = buildMigrationPrompt(spec);
    expect(prompt).toContain('markdown-blocks');
    expect(prompt).toContain('tools/migration-sdk/src/legacy/markdown-blocks.ts');
    expect(prompt).toContain('config/migration-flags/prod.json');
    expect(prompt).toContain('cargo test --workspace');
  });

  it('formats flags matrix, terminal scorecard, and Markdown PR scorecard', () => {
    const matrix = formatFlagsMatrixTerminal(loadAllEnvironmentFlags());
    expect(matrix).toContain('word-count');
    expect(matrix).toContain('outline-toc');
    expect(matrix).toContain('markdown-blocks');
    expect(matrix).toContain('prod (PROTECTED)');

    const term = formatQaScorecardTerminal(SAMPLE_REPORT);
    expect(term).toContain('PASS_FOR_HUMAN_REVIEW');
    expect(term).toContain('18.00x faster');

    const md = formatQaScorecardMarkdown(SAMPLE_REPORT);
    expect(md).toContain('## MarkText -> MarkText-GPUI Migration QA Scorecard: `outline-toc`');
    expect(md).toContain('**18.00x**');
    expect(md).toContain('CODEOWNERS');
  });

  it('explicitly labels deterministic-only mode when Cursor SDK QA is skipped', async () => {
    const logs: string[] = [];
    const verdict = await runSdkQaReviewer({
      report: SAMPLE_REPORT,
      deterministicOnly: true,
      onLog: (line) => logs.push(line),
    });

    expect(verdict.mode).toBe('deterministic-only');
    expect(verdict.verdict).toBe('SKIPPED');
    expect(logs.some((l) => l.includes('[MODE: DETERMINISTIC-ONLY'))).toBe(true);
  });

  it('throws typed SdkStartupError when CURSOR_API_KEY is missing and fallback is not allowed', async () => {
    const prevKey = process.env.CURSOR_API_KEY;
    try {
      delete process.env.CURSOR_API_KEY;
      await expect(
        runSdkQaReviewer({
          report: SAMPLE_REPORT,
          deterministicOnly: false,
          allowDeterministicFallback: false,
        }),
      ).rejects.toBeInstanceOf(SdkStartupError);
    } finally {
      if (prevKey !== undefined) {
        process.env.CURSOR_API_KEY = prevKey;
      }
    }
  });

  it('detects nested object and array diffs with deepCompare', () => {
    expect(deepCompare({ a: [1, 2] }, { a: [1, 2] }).equal).toBe(true);
    const mismatch = deepCompare({ a: [{ x: 1 }] }, { a: [{ x: 2 }] });
    expect(mismatch.equal).toBe(false);
    expect(mismatch.diffExcerpt).toContain('$.a[0].x');
  });
});
