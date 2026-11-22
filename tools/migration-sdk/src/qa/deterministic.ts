import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { deepCompare } from '../flags.js';
import { runLegacyBenchmark } from '../legacy/runner.js';
import { loadMigrationSpec, resolveRepoRoot } from '../paths.js';
import { locateRustCli, runRustCli } from '../rust-bridge.js';
import type {
  BenchmarkComparison,
  CargoCheckResult,
  ParityFileResult,
  ParitySummary,
  QaDeterministicReport,
} from '../types.js';
import { evaluatePolicies, type PolicyRule } from './policy.js';

const execFileAsync = promisify(execFile);

export interface DeterministicQaOptions {
  componentId: string;
  baseRef?: string;
  repoRoot?: string;
  iterations?: number;
  benchmarkIterations?: number;
  runCargoChecks?: boolean;
  allowProdPromotion?: boolean;
  changedFilesOverride?: string[];
  policyRules?: readonly PolicyRule[];
}

export async function getChangedFiles(
  repoRoot: string,
  baseRef?: string,
): Promise<string[]> {
  try {
    if (baseRef) {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--name-only', `${baseRef}...HEAD`],
        { cwd: repoRoot },
      );
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    }

    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoRoot,
    });
    return stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const filePart = line.slice(3).trim();
        // Handle rename syntax `old -> new`
        const arrowIdx = filePart.indexOf(' -> ');
        return arrowIdx >= 0 ? filePart.slice(arrowIdx + 4) : filePart;
      });
  } catch {
    return [];
  }
}

export async function getDiffExcerpt(
  repoRoot: string,
  baseRef?: string,
  maxChars = 12_000,
): Promise<string> {
  try {
    const args = baseRef
      ? ['diff', '--unified=3', `${baseRef}...HEAD`]
      : ['diff', '--unified=3', 'HEAD'];
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (stdout.length <= maxChars) return stdout;
    return `${stdout.slice(0, maxChars)}\n... [diff truncated at ${maxChars} chars]`;
  } catch {
    return '';
  }
}

async function runCargoCommand(
  repoRoot: string,
  args: string[],
): Promise<CargoCheckResult> {
  const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');
  const [subcommand, ...rest] = args;
  const fullArgs = subcommand
    ? [subcommand, '--manifest-path', manifestPath, ...rest]
    : args;
  const command = subcommand
    ? `cargo ${subcommand} --manifest-path rust/Cargo.toml ${rest.join(' ')}`.trim()
    : `cargo ${args.join(' ')}`;

  if (!fs.existsSync(manifestPath)) {
    return {
      executed: false,
      passed: false,
      durationMs: 0,
      command,
      outputExcerpt: `Rust workspace manifest not found at ${manifestPath}`,
    };
  }

  const t0 = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync('cargo', fullArgs, {
      cwd: repoRoot,
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return {
      executed: true,
      passed: true,
      durationMs: Math.round(performance.now() - t0),
      command,
      outputExcerpt: combined.slice(-1200),
    };
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const combined = [execErr.stdout, execErr.stderr, execErr.message]
      .filter(Boolean)
      .join('\n')
      .trim();
    return {
      executed: true,
      passed: false,
      durationMs: Math.round(performance.now() - t0),
      command,
      outputExcerpt: combined.slice(-1600),
    };
  }
}

function safeRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * Phase A — Deterministic Verification Harness:
 * 1. Optional `cargo test --workspace` + `cargo clippy --workspace --all-targets`.
 * 2. Legacy TS vs Rust `marktext-core-cli` exact parity across all files in `evals/corpus/`.
 * 3. Before (Legacy Node/TS) vs After (Rust native) latency, speedup, RSS memory, binary size.
 * 4. Enterprise policy guardrails.
 */
export async function runDeterministicQa(
  options: DeterministicQaOptions,
): Promise<QaDeterministicReport> {
  const startTotal = performance.now();
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const spec = loadMigrationSpec(options.componentId, repoRoot);
  const corpusDir = path.join(repoRoot, spec.corpusDir);

  if (!fs.existsSync(corpusDir)) {
    throw new Error(`Corpus directory not found: ${corpusDir}`);
  }

  const corpusFiles = fs
    .readdirSync(corpusDir)
    .filter((f) => f.endsWith('.md'))
    .sort();

  const changedFiles =
    options.changedFilesOverride ?? (await getChangedFiles(repoRoot, options.baseRef));

  let cargoTest: CargoCheckResult | undefined;
  let cargoClippy: CargoCheckResult | undefined;
  if (options.runCargoChecks) {
    cargoTest = await runCargoCommand(repoRoot, ['test', '--workspace']);
    cargoClippy = await runCargoCommand(repoRoot, [
      'clippy',
      '--workspace',
      '--all-targets',
      '--',
      '-D',
      'warnings',
    ]);
  }

  // Determine which corpus file is the primary benchmark fixture
  let benchmarkFileName =
    corpusFiles.find((f) => f.includes('large-benchmark')) ?? corpusFiles[0] ?? '';
  let maxFileSize = -1;
  if (!benchmarkFileName.includes('large-benchmark')) {
    for (const f of corpusFiles) {
      const size = fs.statSync(path.join(corpusDir, f)).size;
      if (size > maxFileSize) {
        maxFileSize = size;
        benchmarkFileName = f;
      }
    }
  }

  const defaultIterations = options.iterations ?? 40;
  const largeIterations = options.benchmarkIterations ?? 150;

  const fileResults: ParityFileResult[] = [];
  let benchmarkFileResult: ParityFileResult | undefined;

  for (const filename of corpusFiles) {
    const absPath = path.join(corpusDir, filename);
    const markdown = fs.readFileSync(absPath, 'utf8');
    const bytes = Buffer.byteLength(markdown, 'utf8');
    const isLarge = filename === benchmarkFileName;
    const iters = isLarge ? largeIterations : defaultIterations;

    const legacyRun = runLegacyBenchmark(spec.legacyHarnessEntry, markdown, iters);

    let result: ParityFileResult;
    try {
      const rustRun = await runRustCli(spec.rustSubcommand, absPath, {
        iterations: iters,
        repoRoot,
      });
      const cmp = deepCompare(legacyRun.output, rustRun.output);
      result = {
        file: filename,
        bytes,
        match: cmp.equal,
        legacyMetrics: legacyRun.metrics,
        rustMetrics: rustRun.metrics,
        speedupP50: safeRatio(legacyRun.metrics.p50Ms, rustRun.metrics.p50Ms) ?? undefined,
        speedupP95: safeRatio(legacyRun.metrics.p95Ms, rustRun.metrics.p95Ms) ?? undefined,
        diffExcerpt: cmp.diffExcerpt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result = {
        file: filename,
        bytes,
        match: false,
        legacyMetrics: legacyRun.metrics,
        rustError: message,
        diffExcerpt: `Rust CLI error: ${message}`,
      };
    }

    fileResults.push(result);
    if (isLarge) {
      benchmarkFileResult = result;
    }
  }

  const matchedFiles = fileResults.filter((f) => f.match).length;
  const totalFiles = fileResults.length;
  const mismatchedFiles = totalFiles - matchedFiles;
  const parityPercent = totalFiles > 0 ? (matchedFiles / totalFiles) * 100 : 0;

  const parity: ParitySummary = {
    totalFiles,
    matchedFiles,
    mismatchedFiles,
    parityPercent,
    exactMatch: totalFiles > 0 && mismatchedFiles === 0,
    files: fileResults,
  };

  const rustCliInfo = locateRustCli(repoRoot);
  const benchLegacy = benchmarkFileResult?.legacyMetrics;
  const benchRust = benchmarkFileResult?.rustMetrics;

  const benchmark: BenchmarkComparison = {
    benchmarkFile: benchmarkFileName,
    iterations: benchLegacy?.iterations ?? largeIterations,
    legacyP50Ms: benchLegacy?.p50Ms ?? 0,
    legacyP95Ms: benchLegacy?.p95Ms ?? 0,
    legacyMeanMs: benchLegacy?.meanMs ?? 0,
    legacyPeakRssKb: benchLegacy?.peakRssKb ?? 0,
    rustP50Ms: benchRust ? benchRust.p50Ms : null,
    rustP95Ms: benchRust ? benchRust.p95Ms : null,
    rustMeanMs: benchRust ? benchRust.meanMs : null,
    rustPeakRssKb: benchRust ? benchRust.peakRssKb : null,
    speedupP50:
      benchLegacy && benchRust ? safeRatio(benchLegacy.p50Ms, benchRust.p50Ms) : null,
    speedupP95:
      benchLegacy && benchRust ? safeRatio(benchLegacy.p95Ms, benchRust.p95Ms) : null,
    rssReductionRatio:
      benchLegacy && benchRust && benchRust.peakRssKb > 0
        ? safeRatio(benchLegacy.peakRssKb, benchRust.peakRssKb)
        : null,
    rustBinarySizeKb: rustCliInfo.binarySizeKb,
  };

  const policies = evaluatePolicies(
    {
      spec,
      changedFiles,
      parity,
      benchmark,
      allowProdPromotion: options.allowProdPromotion,
      enforceAllowedPathScope: Boolean(options.baseRef),
    },
    options.policyRules,
  );

  const cargoPassed = (cargoTest?.passed ?? true) && (cargoClippy?.passed ?? true);
  const policiesPassed = policies.every((p) => p.passed);

  return {
    timestamp: new Date().toISOString(),
    componentId: spec.componentId,
    specTitle: spec.title,
    baseRef: options.baseRef,
    changedFiles,
    cargoTest,
    cargoClippy,
    parity,
    benchmark,
    policies,
    passed: cargoPassed && policiesPassed,
    durationMs: Math.round(performance.now() - startTotal),
  };
}
