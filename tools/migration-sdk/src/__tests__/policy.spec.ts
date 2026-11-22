import { describe, expect, it } from 'vitest';
import { loadMigrationSpec } from '../paths.js';
import { evaluatePolicies } from '../qa/policy.js';
import type { BenchmarkComparison, ParitySummary } from '../types.js';

const PASSING_PARITY: ParitySummary = {
  totalFiles: 5,
  matchedFiles: 5,
  mismatchedFiles: 0,
  parityPercent: 100,
  exactMatch: true,
  files: [],
};

const PASSING_BENCHMARK: BenchmarkComparison = {
  benchmarkFile: '05-large-benchmark.md',
  iterations: 150,
  legacyP50Ms: 4.5,
  legacyP95Ms: 6.0,
  legacyMeanMs: 4.8,
  legacyPeakRssKb: 72_000,
  rustP50Ms: 0.25,
  rustP95Ms: 0.4,
  rustMeanMs: 0.28,
  rustPeakRssKb: 4_200,
  speedupP50: 18.0,
  speedupP95: 15.0,
  rssReductionRatio: 17.14,
  rustBinarySizeKb: 1_800,
};

describe('enterprise migration policy gates', () => {
  it('HARD BLOCKS any PR touching config/migration-flags/prod.json without explicit flag', () => {
    const spec = loadMigrationSpec('word-count');
    const results = evaluatePolicies({
      spec,
      changedFiles: ['config/migration-flags/prod.json'],
      parity: PASSING_PARITY,
      benchmark: PASSING_BENCHMARK,
      allowProdPromotion: false,
      enforceAllowedPathScope: true,
    });

    const prodRule = results.find((r) => r.ruleId === 'no-prod-flag-mutation');
    expect(prodRule?.passed).toBe(false);
    expect(prodRule?.severity).toBe('HARD_BLOCK');
  });

  it('HARD BLOCKS any PR touching .github/CODEOWNERS or .github/workflows/', () => {
    const spec = loadMigrationSpec('outline-toc');
    const results = evaluatePolicies({
      spec,
      changedFiles: ['.github/CODEOWNERS', '.github/workflows/migration-qa.yml'],
      parity: PASSING_PARITY,
      benchmark: PASSING_BENCHMARK,
      enforceAllowedPathScope: true,
    });

    const govRule = results.find((r) => r.ruleId === 'no-governance-tampering');
    expect(govRule?.passed).toBe(false);
    expect(govRule?.severity).toBe('HARD_BLOCK');
    expect(govRule?.details).toEqual([
      '.github/CODEOWNERS',
      '.github/workflows/migration-qa.yml',
    ]);
  });

  it('HARD BLOCKS modifying or deleting forbidden legacy implementation paths', () => {
    const spec = loadMigrationSpec('word-count');
    const results = evaluatePolicies({
      spec,
      changedFiles: ['packages/muya/src/utils/index.ts'],
      parity: PASSING_PARITY,
      benchmark: PASSING_BENCHMARK,
      enforceAllowedPathScope: true,
    });

    const legacyRule = results.find((r) => r.ruleId === 'preserve-legacy-path');
    expect(legacyRule?.passed).toBe(false);
    expect(legacyRule?.severity).toBe('HARD_BLOCK');
  });

  it('BLOCKS files modified outside spec.allowedPaths when enforcing branch scope', () => {
    const spec = loadMigrationSpec('markdown-blocks');
    const results = evaluatePolicies({
      spec,
      changedFiles: ['rust/crates/marktext-core/src/markdown_blocks.rs', 'README.md'],
      parity: PASSING_PARITY,
      benchmark: PASSING_BENCHMARK,
      enforceAllowedPathScope: true,
    });

    const scopeRule = results.find((r) => r.ruleId === 'allowed-path-scope');
    expect(scopeRule?.passed).toBe(false);
    expect(scopeRule?.details).toEqual(['README.md']);
  });

  it('BLOCKS when exact parity is required and any corpus file mismatches', () => {
    const spec = loadMigrationSpec('outline-toc');
    const failingParity: ParitySummary = {
      ...PASSING_PARITY,
      matchedFiles: 4,
      mismatchedFiles: 1,
      parityPercent: 80,
      exactMatch: false,
      files: [
        {
          file: '03-edge-cases.md',
          bytes: 512,
          match: false,
          legacyMetrics: { iterations: 40, p50Ms: 0.2, p95Ms: 0.4, meanMs: 0.22, peakRssKb: 60000 },
          diffExcerpt: '$[2].githubSlug: legacy="foo" vs rust="bar"',
        },
      ],
    };

    const results = evaluatePolicies({
      spec,
      changedFiles: ['rust/crates/marktext-core/src/outline_toc.rs'],
      parity: failingParity,
      benchmark: PASSING_BENCHMARK,
      enforceAllowedPathScope: true,
    });

    const parityRule = results.find((r) => r.ruleId === 'exact-parity-required');
    expect(parityRule?.passed).toBe(false);
  });

  it('BLOCKS when Rust p95 latency exceeds budget or speedup is below minSpeedupRatio', () => {
    const spec = loadMigrationSpec('word-count');
    const slowBench: BenchmarkComparison = {
      ...PASSING_BENCHMARK,
      rustP95Ms: 25.0,
      speedupP50: 0.8,
      speedupP95: 0.5,
    };

    const results = evaluatePolicies({
      spec,
      changedFiles: ['rust/crates/marktext-core/src/word_count.rs'],
      parity: PASSING_PARITY,
      benchmark: slowBench,
      enforceAllowedPathScope: true,
    });

    const perfRule = results.find((r) => r.ruleId === 'perf-budget-gate');
    expect(perfRule?.passed).toBe(false);
    expect(perfRule?.details?.length).toBe(2);
  });

  it('PASSES all policies for a clean, in-scope PR meeting parity and performance budgets', () => {
    const spec = loadMigrationSpec('word-count');
    const results = evaluatePolicies({
      spec,
      changedFiles: [
        'rust/crates/marktext-core/src/word_count.rs',
        'config/migration-flags/dev.json',
      ],
      parity: PASSING_PARITY,
      benchmark: PASSING_BENCHMARK,
      enforceAllowedPathScope: true,
    });

    expect(results.every((r) => r.passed)).toBe(true);
  });
});
