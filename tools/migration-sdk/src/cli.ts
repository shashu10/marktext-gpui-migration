import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { dispatchCloudMigration } from './dispatch.js';
import { loadAllEnvironmentFlags, runWithFeatureFlag } from './flags.js';
import { executeLegacyComponent } from './legacy/runner.js';
import {
  loadEnvConfig,
  loadMigrationSpec,
  resolveRepoRoot,
  writeEvalRunRecord,
} from './paths.js';
import { runDeterministicQa } from './qa/deterministic.js';
import { evaluatePolicies } from './qa/policy.js';
import {
  runSdkQaReviewer,
  SdkRunExecutionError,
  SdkStartupError,
} from './qa/sdk-reviewer.js';
import {
  formatFlagsMatrixTerminal,
  formatQaScorecardMarkdown,
  formatQaScorecardTerminal,
} from './report.js';
import { runRustCli } from './rust-bridge.js';
import type { EvalRunRecord, QaDeterministicReport, SdkQaVerdict } from './types.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positionals: string[];
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const cleaned = argv.filter((arg, idx) => !(idx === 0 && arg === '--'));
  const [command = 'help', ...rest] = cleaned;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const eqIdx = token.indexOf('=');
      if (eqIdx > 2) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }

  return { command, flags, positionals };
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const val = flags[key];
  return typeof val === 'string' ? val : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === 'true';
}

function printHelp(): void {
  console.log(`MarkText -> MarkText-GPUI AI SDLC Migration CLI (@marktext-migration/sdk)

Usage:
  tsx src/cli.ts demo [--deterministic-only]
  tsx src/cli.ts qa --component <id> [--base <ref>] [--deterministic-only] [--allow-deterministic-fallback] [--allow-prod-promotion] [--skip-cargo] [--output-md <path>]
  tsx src/cli.ts dispatch --component <id> --repo <owner/repo> [--branch <ref>] [--dry-run]
  tsx src/cli.ts flags

Exit Codes:
  0  Success (PASS_FOR_HUMAN_REVIEW / Cloud Agent finished)
  1  Startup, config, auth, or network failure (CursorAgentError)
  2  Execution or verification failure (QA BLOCK, parity mismatch, policy violation, run error)`);
}

async function handleFlags(): Promise<number> {
  const repoRoot = resolveRepoRoot();
  const allFlags = loadAllEnvironmentFlags(repoRoot);
  console.log(formatFlagsMatrixTerminal(allFlags));
  return 0;
}

async function handleQa(flags: Record<string, string | boolean>): Promise<number> {
  const t0 = performance.now();
  const repoRoot = resolveRepoRoot();
  const componentId = stringFlag(flags, 'component');
  if (!componentId) {
    console.error('Error: --component <id> is required (e.g., --component word-count)');
    return 1;
  }

  const baseRef = stringFlag(flags, 'base');
  const deterministicOnly = boolFlag(flags, 'deterministic-only');
  const allowDeterministicFallback = boolFlag(flags, 'allow-deterministic-fallback');
  const allowProdPromotion = boolFlag(flags, 'allow-prod-promotion');
  const skipCargo = boolFlag(flags, 'skip-cargo');
  const outputMd = stringFlag(flags, 'output-md');
  const modelId = stringFlag(flags, 'model');

  let report: QaDeterministicReport;
  try {
    report = await runDeterministicQa({
      componentId,
      baseRef,
      repoRoot,
      runCargoChecks: !skipCargo,
      allowProdPromotion,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`QA startup/configuration error: ${message}`);
    return 1;
  }

  let sdkVerdict: SdkQaVerdict;
  try {
    sdkVerdict = await runSdkQaReviewer({
      report,
      repoRoot,
      baseRef,
      modelId,
      deterministicOnly,
      allowDeterministicFallback,
    });
  } catch (err) {
    const durationMs = Math.round(performance.now() - t0);
    if (err instanceof SdkStartupError) {
      console.error(
        `[EXIT 1 — STARTUP/AUTH ERROR] ${err.message} (retryable=${err.isRetryable})`,
      );
      writeEvalRunRecord(
        {
          id: `qa-startup-err-${Date.now()}`,
          timestamp: new Date().toISOString(),
          kind: 'qa',
          componentId,
          mode: 'live-sdk',
          status: 'startup_error',
          exitCode: 1,
          durationMs,
          deterministic: report,
          metadata: { error: err.message, isRetryable: err.isRetryable, code: err.code },
        },
        repoRoot,
      );
      return 1;
    }
    if (err instanceof SdkRunExecutionError) {
      console.error(
        `[EXIT 2 — SDK RUN FAILURE] agentId=${err.agentId} runId=${err.runId} status=${err.runStatus}: ${err.message}`,
      );
      writeEvalRunRecord(
        {
          id: `qa-run-err-${err.runId}`,
          timestamp: new Date().toISOString(),
          kind: 'qa',
          componentId,
          mode: 'live-sdk',
          status: 'run_error',
          exitCode: 2,
          durationMs,
          agentId: err.agentId,
          runId: err.runId,
          deterministic: report,
          metadata: { error: err.message, runStatus: err.runStatus },
        },
        repoRoot,
      );
      return 2;
    }
    throw err;
  }

  console.log(formatQaScorecardTerminal(report, sdkVerdict));

  if (outputMd) {
    const mdContent = formatQaScorecardMarkdown(report, sdkVerdict);
    const absMd = path.isAbsolute(outputMd) ? outputMd : path.resolve(process.cwd(), outputMd);
    fs.mkdirSync(path.dirname(absMd), { recursive: true });
    fs.writeFileSync(absMd, mdContent, 'utf8');
    console.log(`\nWrote Markdown PR scorecard to ${absMd}`);
  }

  const passed = report.passed && sdkVerdict.verdict !== 'BLOCK';
  const exitCode: 0 | 2 = passed ? 0 : 2;
  const record: EvalRunRecord = {
    id: `qa-${componentId}-${Date.now()}`,
    timestamp: new Date().toISOString(),
    kind: 'qa',
    componentId,
    mode: sdkVerdict.mode,
    status: passed ? 'passed' : 'blocked',
    exitCode,
    durationMs: Math.round(performance.now() - t0),
    agentId: sdkVerdict.agentId,
    runId: sdkVerdict.runId,
    deterministic: report,
    sdkVerdict,
  };
  const recordPath = writeEvalRunRecord(record, repoRoot);
  console.log(`\nEval telemetry written to ${path.relative(repoRoot, recordPath)}`);
  return exitCode;
}

async function handleDispatch(flags: Record<string, string | boolean>): Promise<number> {
  const componentId = stringFlag(flags, 'component');
  const repo = stringFlag(flags, 'repo');
  const branch = stringFlag(flags, 'branch') ?? 'main';
  const dryRun = boolFlag(flags, 'dry-run');
  const modelId = stringFlag(flags, 'model');

  if (!componentId) {
    console.error('Error: --component <id> is required (e.g., --component markdown-blocks)');
    return 1;
  }
  if (!repo) {
    console.error('Error: --repo <owner/repo> is required');
    return 1;
  }

  try {
    const res = await dispatchCloudMigration({
      componentId,
      repo,
      branch,
      dryRun,
      modelId,
    });
    console.log(
      `\nDispatch complete: status=${res.status} component=${res.componentId}${res.agentId ? ` agentId=${res.agentId}` : ''}${res.runId ? ` runId=${res.runId}` : ''}${res.prUrl ? ` prUrl=${res.prUrl}` : ''}`,
    );
    console.log(`Telemetry record: ${res.recordPath}`);
    return 0;
  } catch (err) {
    if (err instanceof SdkStartupError) {
      console.error(
        `[EXIT 1 — STARTUP/AUTH ERROR] ${err.message} (retryable=${err.isRetryable})`,
      );
      return 1;
    }
    if (err instanceof SdkRunExecutionError) {
      console.error(
        `[EXIT 2 — CLOUD AGENT RUN ERROR] agentId=${err.agentId} runId=${err.runId} status=${err.runStatus}: ${err.message}`,
      );
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[EXIT 1 — DISPATCH CONFIG ERROR] ${message}`);
    return 1;
  }
}

async function handleDemo(flags: Record<string, string | boolean>): Promise<number> {
  const t0 = performance.now();
  const repoRoot = resolveRepoRoot();
  const deterministicOnly = boolFlag(flags, 'deterministic-only');
  const envCfg = loadEnvConfig(repoRoot);

  console.log('================================================================================');
  console.log('  MarkText -> MarkText-GPUI ("The Messy Middle") — End-to-End AI SDLC Demo');
  console.log('================================================================================\n');

  // 1. Control Plane Matrix
  const allFlags = loadAllEnvironmentFlags(repoRoot);
  console.log(formatFlagsMatrixTerminal(allFlags));

  // 2. Live Strangler-Fig Router Showcase (dev / staging / messy-middle fallback)
  console.log('\n=== Live Strangler-Fig Feature Flag Routing ===');
  const sampleDocPath = path.join(repoRoot, 'evals', 'corpus', '01-enterprise-spec.md');
  const sampleMarkdown = fs.readFileSync(sampleDocPath, 'utf8');

  // 2a. word-count in staging (migrated -> rust-core)
  const wordCountRoute = await runWithFeatureFlag(
    'staging',
    'word-count',
    () => executeLegacyComponent('word-count', sampleMarkdown),
    async () => (await runRustCli('word-count', sampleDocPath, { iterations: 10, repoRoot })).output,
    { repoRoot },
  );
  console.log(
    `[staging] word-count      -> mode=${wordCountRoute.mode} activeEngine=${wordCountRoute.activeEngine} fellBack=${wordCountRoute.fellBackToLegacy}`,
  );

  // 2b. outline-toc in staging (shadow dual-run -> compares legacy-ts & rust-core)
  const outlineRoute = await runWithFeatureFlag(
    'staging',
    'outline-toc',
    () => executeLegacyComponent('outline-toc', sampleMarkdown),
    async () => (await runRustCli('outline-toc', sampleDocPath, { iterations: 10, repoRoot })).output,
    { repoRoot, randomFn: () => 0 },
  );
  console.log(
    `[staging] outline-toc     -> mode=${outlineRoute.mode} activeEngine=${outlineRoute.activeEngine} shadowParityMatch=${outlineRoute.shadowParityMatch}`,
  );

  // 2c. markdown-blocks ("the messy middle"):
  //     - Under staging config (mode=legacy), routes straight to legacy-ts.
  //     - Even if forcefully flipped to migrated before Rust implements it, fallbackOnError catches
  //       NOT_MIGRATED from Rust and seamlessly falls back to legacy-ts!
  const blocksLegacyRoute = await runWithFeatureFlag(
    'staging',
    'markdown-blocks',
    () => executeLegacyComponent('markdown-blocks', sampleMarkdown),
    async () =>
      (await runRustCli('markdown-blocks', sampleDocPath, { iterations: 5, repoRoot })).output,
    { repoRoot },
  );
  const blocksFallbackRoute = await runWithFeatureFlag(
    'dev',
    'markdown-blocks',
    () => executeLegacyComponent('markdown-blocks', sampleMarkdown),
    async () =>
      (await runRustCli('markdown-blocks', sampleDocPath, { iterations: 5, repoRoot })).output,
    {
      repoRoot,
      flagOverride: {
        mode: 'migrated',
        engine: 'rust-core',
        shadowSampleRate: 0,
        fallbackOnError: true,
      },
    },
  );
  console.log(
    `[staging] markdown-blocks -> mode=${blocksLegacyRoute.mode} activeEngine=${blocksLegacyRoute.activeEngine} (unmigrated subsystem safely on legacy-ts)`,
  );
  console.log(
    `[fallback drill] markdown-blocks (forced migrated -> Rust NOT_MIGRATED) -> activeEngine=${blocksFallbackRoute.activeEngine} fellBackToLegacy=${blocksFallbackRoute.fellBackToLegacy}`,
  );

  // 3. Deterministic Parity + Performance Benchmarks on migrated components
  const migratedComponents = ['word-count', 'outline-toc'] as const;
  const reports: QaDeterministicReport[] = [];

  for (const comp of migratedComponents) {
    const report = await runDeterministicQa({
      componentId: comp,
      repoRoot,
      runCargoChecks: false,
      changedFilesOverride: [],
    });
    reports.push(report);
  }

  // 4. Optional Phase B Cursor SDK QA review on primary migrated component (outline-toc)
  const primaryReport = reports[1] ?? reports[0];
  let sdkVerdict: SdkQaVerdict | undefined;
  if (primaryReport) {
    try {
      sdkVerdict = await runSdkQaReviewer({
        report: primaryReport,
        repoRoot,
        deterministicOnly,
        allowDeterministicFallback: true,
      });
    } catch (err) {
      if (err instanceof SdkStartupError) {
        console.error(
          `[Cursor SDK QA startup error, exit 1] ${err.message} (retryable=${err.isRetryable})`,
        );
        return 1;
      }
      if (err instanceof SdkRunExecutionError) {
        console.error(
          `[Cursor SDK QA run error, exit 2] agentId=${err.agentId} runId=${err.runId}: ${err.message}`,
        );
        return 2;
      }
      throw err;
    }
  }

  for (const report of reports) {
    console.log(
      formatQaScorecardTerminal(
        report,
        report === primaryReport ? sdkVerdict : undefined,
      ),
    );
  }

  // 5. Simulated Policy-Block Self-Test (proves prod.json + CODEOWNERS guardrails hard-block)
  console.log('\n=== Policy Guardrail Self-Test (Simulated Unauthorized PR) ===');
  const wordSpec = loadMigrationSpec('word-count', repoRoot);
  const wordReport = reports[0]!;
  const simulatedPolicies = evaluatePolicies({
    spec: wordSpec,
    changedFiles: ['config/migration-flags/prod.json', '.github/CODEOWNERS'],
    parity: wordReport.parity,
    benchmark: wordReport.benchmark,
    allowProdPromotion: false,
    enforceAllowedPathScope: true,
  });
  const blockedRules = simulatedPolicies.filter((p) => !p.passed);
  for (const rule of blockedRules) {
    console.log(`  [${rule.severity}] ${rule.ruleId}: ${rule.message}`);
  }
  console.log(
    `  Self-test verdict: ${blockedRules.length >= 2 ? 'BLOCKED as expected (prod.json & CODEOWNERS protected)' : 'UNEXPECTED PASS'}`,
  );

  // 6. Write demo telemetry ledger record
  const allPassed =
    reports.every((r) => r.passed) &&
    blockedRules.length >= 2 &&
    (!sdkVerdict || sdkVerdict.verdict !== 'BLOCK');

  const record: EvalRunRecord = {
    id: `demo-${Date.now()}`,
    timestamp: new Date().toISOString(),
    kind: 'demo',
    componentId: 'all-migrated',
    mode: sdkVerdict?.mode ?? (deterministicOnly || !envCfg.apiKey ? 'deterministic-only' : 'live-sdk'),
    status: allPassed ? 'passed' : 'blocked',
    exitCode: allPassed ? 0 : 2,
    durationMs: Math.round(performance.now() - t0),
    agentId: sdkVerdict?.agentId,
    runId: sdkVerdict?.runId,
    deterministic: primaryReport,
    sdkVerdict,
    metadata: {
      componentsBenchmarked: reports.map((r) => ({
        componentId: r.componentId,
        parityPercent: r.parity.parityPercent,
        legacyP50Ms: r.benchmark.legacyP50Ms,
        rustP50Ms: r.benchmark.rustP50Ms,
        speedupP50: r.benchmark.speedupP50,
        legacyPeakRssKb: r.benchmark.legacyPeakRssKb,
        rustPeakRssKb: r.benchmark.rustPeakRssKb,
      })),
      messyMiddleFallbackVerified: blocksFallbackRoute.fellBackToLegacy,
      policyBlockSelfTestTriggeredRules: blockedRules.map((r) => r.ruleId),
    },
  };
  const recordPath = writeEvalRunRecord(record, repoRoot);

  console.log('\n================================================================================');
  console.log(`  Demo Complete | Status: ${allPassed ? 'PASS' : 'BLOCK'} | Telemetry: ${path.relative(repoRoot, recordPath)}`);
  console.log('================================================================================');

  return allPassed ? 0 : 2;
}

async function main(): Promise<void> {
  const { command, flags } = parseCliArgs(process.argv.slice(2));

  let exitCode: number;
  switch (command) {
    case 'flags':
      exitCode = await handleFlags();
      break;
    case 'qa':
      exitCode = await handleQa(flags);
      break;
    case 'dispatch':
      exitCode = await handleDispatch(flags);
      break;
    case 'demo':
      exitCode = await handleDemo(flags);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      exitCode = 0;
      break;
    default:
      console.error(`Unknown command "${command}". Run with --help for usage.`);
      exitCode = 1;
      break;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error('Unhandled fatal error:', err);
  process.exit(1);
});
