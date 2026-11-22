import { Agent, CursorAgentError } from '@cursor/sdk';
import { performance } from 'node:perf_hooks';
import { loadEnvConfig, loadMigrationSpec, resolveRepoRoot } from '../paths.js';
import type { QaDeterministicReport, SdkQaFinding, SdkQaVerdict } from '../types.js';
import { getDiffExcerpt } from './deterministic.js';

/**
 * Thrown when `@cursor/sdk` fails before execution starts (auth, config, network).
 * CLI maps this to exit code `1`.
 */
export class SdkStartupError extends Error {
  readonly isRetryable: boolean;
  readonly code?: string;
  readonly status?: number;

  constructor(
    message: string,
    opts: { isRetryable?: boolean; code?: string; status?: number } = {},
  ) {
    super(message);
    this.name = 'SdkStartupError';
    this.isRetryable = opts.isRetryable ?? false;
    this.code = opts.code;
    this.status = opts.status;
  }
}

/**
 * Thrown when `@cursor/sdk` run started and failed mid-flight (`result.status !== "finished"`).
 * CLI maps this to exit code `2`.
 */
export class SdkRunExecutionError extends Error {
  readonly agentId: string;
  readonly runId: string;
  readonly runStatus: string;

  constructor(message: string, agentId: string, runId: string, runStatus: string) {
    super(message);
    this.name = 'SdkRunExecutionError';
    this.agentId = agentId;
    this.runId = runId;
    this.runStatus = runStatus;
  }
}

export interface SdkQaReviewOptions {
  report: QaDeterministicReport;
  repoRoot?: string;
  baseRef?: string;
  modelId?: string;
  deterministicOnly?: boolean;
  allowDeterministicFallback?: boolean;
  onLog?: (line: string) => void;
}

interface RawVerdictShape {
  verdict?: string;
  summary?: string;
  findings?: Array<{
    severity?: string;
    category?: string;
    file?: string;
    message?: string;
  }>;
  recommendedActions?: string[];
}

function parseVerdictJson(text: string): RawVerdictShape | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Prefer the last ```json ... ``` fenced block if present
  const fenceMatches = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const candidate = fenceMatches[i]?.[1]?.trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as RawVerdictShape;
      if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
        return parsed;
      }
    } catch {
      // try earlier block
    }
  }

  // Fallback: attempt to extract outermost JSON object containing "verdict"
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as RawVerdictShape;
      if (parsed && typeof parsed === 'object' && 'verdict' in parsed) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function normalizeSeverity(raw?: string): SdkQaFinding['severity'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    case 'low':
      return 'low';
    default:
      return 'info';
  }
}

function buildQaPrompt(
  report: QaDeterministicReport,
  acceptanceCriteria: string[],
  diffExcerpt: string,
): string {
  const reportSummary = {
    componentId: report.componentId,
    specTitle: report.specTitle,
    passedDeterministicGate: report.passed,
    changedFiles: report.changedFiles,
    cargoTest: report.cargoTest
      ? { passed: report.cargoTest.passed, durationMs: report.cargoTest.durationMs }
      : undefined,
    cargoClippy: report.cargoClippy
      ? { passed: report.cargoClippy.passed, durationMs: report.cargoClippy.durationMs }
      : undefined,
    parity: {
      totalFiles: report.parity.totalFiles,
      matchedFiles: report.parity.matchedFiles,
      parityPercent: report.parity.parityPercent,
      exactMatch: report.parity.exactMatch,
      mismatches: report.parity.files
        .filter((f) => !f.match)
        .map((f) => ({ file: f.file, diffExcerpt: f.diffExcerpt, rustError: f.rustError })),
    },
    benchmark: report.benchmark,
    policies: report.policies,
  };

  return [
    `You are an independent QA Verification Agent reviewing an incremental MarkText -> MarkText-GPUI strangler-fig migration for component "${report.componentId}".`,
    '',
    'Your job is STRICTLY READ-ONLY review. Do NOT modify files.',
    'Review the Phase A deterministic QA report, acceptance criteria, and bounded git diff below for:',
    '1. Semantic regressions or subtle edge-case drift (UTF-16, CJK, CRLF, fenced blocks, empty inputs).',
    '2. Unsafe Rust error handling (panics, unwrap()/expect() on untrusted input).',
    '3. Feature-flag safety (prod.json protection, graceful legacy fallback intact).',
    '4. Any mismatch between deterministic metrics/policies and acceptance criteria.',
    '',
    'Acceptance Criteria:',
    ...acceptanceCriteria.map((c, idx) => `${idx + 1}. ${c}`),
    '',
    'Phase A Deterministic QA Report (JSON):',
    '```json',
    JSON.stringify(reportSummary, null, 2),
    '```',
    '',
    diffExcerpt
      ? `Bounded Git Diff:\n\`\`\`diff\n${diffExcerpt}\n\`\`\``
      : 'Bounded Git Diff: (no local diff — inspect the Rust module referenced by the component spec if needed).',
    '',
    'Respond with ONLY a single ```json``` code block matching this exact schema:',
    '```json',
    '{',
    '  "verdict": "PASS_FOR_HUMAN_REVIEW" | "BLOCK",',
    '  "summary": "Concise 1-2 sentence assessment",',
    '  "findings": [',
    '    { "severity": "critical" | "high" | "medium" | "low" | "info", "category": "parity|safety|flags|perf|tests", "file": "optional/path", "message": "..." }',
    '  ],',
    '  "recommendedActions": ["..."]',
    '}',
    '```',
    'Rules: If Phase A deterministic gate failed (`passedDeterministicGate: false`), you MUST emit verdict "BLOCK".',
  ].join('\n');
}

/**
 * Phase B — Scoped `@cursor/sdk` QA Verification Agent.
 *
 * Adheres strictly to AGENTS.md Section 2 guardrails:
 * - Explicit `local: { cwd, settingSources: [] }` runtime
 * - Explicit `apiKey` passed from env config
 * - `await using agent = await Agent.create(...)` disposal
 * - Immediate logging of `agent.agentId` and `run.id` after `send()`
 * - Always calls `await run.wait()`
 * - Separates thrown `CursorAgentError` (exit 1) from `result.status === "error"` (exit 2)
 */
export async function runSdkQaReviewer(
  options: SdkQaReviewOptions,
): Promise<SdkQaVerdict> {
  const log = options.onLog ?? ((line: string) => console.log(line));
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const envCfg = loadEnvConfig(repoRoot);
  const modelId = options.modelId ?? envCfg.modelId;

  if (options.deterministicOnly) {
    const reason = '--deterministic-only flag was set';
    log(`[MODE: DETERMINISTIC-ONLY — Cursor SDK QA Agent skipped because ${reason}]`);
    return {
      mode: 'deterministic-only',
      verdict: 'SKIPPED',
      summary: `Cursor SDK QA Agent skipped (${reason}). Verdict governed by Phase A deterministic harness.`,
      findings: [],
      recommendedActions: [
        'Provide CURSOR_API_KEY and re-run without --deterministic-only for Phase B SDK semantic QA review.',
      ],
      skipReason: reason,
    };
  }

  if (!envCfg.apiKey) {
    const reason = 'CURSOR_API_KEY is not configured in environment or repo-root .env';
    if (options.allowDeterministicFallback) {
      log(`[MODE: DETERMINISTIC-ONLY — Cursor SDK QA Agent skipped because ${reason}]`);
      return {
        mode: 'deterministic-only',
        verdict: 'SKIPPED',
        summary: `Cursor SDK QA Agent skipped (${reason}). Verdict governed by Phase A deterministic harness.`,
        findings: [],
        recommendedActions: [
          'Export CURSOR_API_KEY (or add it to .env) to enable live @cursor/sdk Phase B QA review.',
        ],
        skipReason: reason,
      };
    }

    throw new SdkStartupError(
      `Missing CURSOR_API_KEY. Set CURSOR_API_KEY in your environment (or .env) or pass --deterministic-only.`,
      { isRetryable: false, code: 'MISSING_API_KEY' },
    );
  }

  const spec = loadMigrationSpec(options.report.componentId, repoRoot);
  const diffExcerpt = await getDiffExcerpt(repoRoot, options.baseRef);
  const prompt = buildQaPrompt(options.report, spec.acceptanceCriteria, diffExcerpt);
  const t0 = performance.now();

  try {
    await using agent = await Agent.create({
      apiKey: envCfg.apiKey,
      model: { id: modelId },
      name: `migration-qa-${options.report.componentId}`,
      // Strict read-only toolset for the independent QA verifier
      tools: ['read', 'grep', 'glob', 'ls'],
      local: {
        cwd: repoRoot,
        settingSources: [],
      },
    });

    const run = await agent.send(prompt);
    // Guardrail 5: Log IDs immediately after send() before streaming/waiting
    log(`[Cursor SDK QA] agentId=${agent.agentId} runId=${run.id} model=${modelId}`);

    const streamedChunks: string[] = [];
    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              streamedChunks.push(block.text);
            }
          }
        } else if (event.type === 'summary') {
          log(
            `[Cursor SDK QA] summary status=${event.status}${event.fallback === true ? ' (fallback)' : ''}`,
          );
        }
        // Intentionally ignore unknown/other message types for forward compatibility
      }
    }

    // Guardrail 3: Always call await run.wait()
    const result = await run.wait();
    const durationMs = Math.round(performance.now() - t0);

    if (result.status !== 'finished') {
      throw new SdkRunExecutionError(
        `Cursor SDK QA run ended with status="${result.status}"${result.error ? `: ${result.error.message}` : ''}`,
        agent.agentId,
        run.id,
        result.status,
      );
    }

    const finalText = result.result ?? streamedChunks.join('');
    const parsed = parseVerdictJson(finalText);

    const deterministicFailed = !options.report.passed;
    const rawVerdict = parsed?.verdict === 'PASS_FOR_HUMAN_REVIEW' ? 'PASS_FOR_HUMAN_REVIEW' : 'BLOCK';
    const effectiveVerdict: 'PASS_FOR_HUMAN_REVIEW' | 'BLOCK' = deterministicFailed
      ? 'BLOCK'
      : rawVerdict;

    const findings: SdkQaFinding[] = (parsed?.findings ?? []).map((f) => ({
      severity: normalizeSeverity(f.severity),
      category: f.category ?? 'review',
      file: f.file,
      message: f.message ?? '',
    }));

    return {
      mode: 'live-sdk',
      verdict: effectiveVerdict,
      summary:
        parsed?.summary ??
        (finalText.trim().slice(0, 300) || 'Cursor SDK QA agent completed without structured JSON verdict.'),
      findings,
      recommendedActions: parsed?.recommendedActions ?? [],
      agentId: agent.agentId,
      runId: run.id,
      modelId,
      durationMs,
      usage: result.usage
        ? {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            totalTokens: result.usage.totalTokens,
          }
        : undefined,
    };
  } catch (err) {
    if (err instanceof SdkRunExecutionError || err instanceof SdkStartupError) {
      throw err;
    }
    if (err instanceof CursorAgentError) {
      throw new SdkStartupError(
        `Cursor SDK startup/API error (${err.code ?? 'SDK_ERROR'}, retryable=${err.isRetryable}): ${err.message}`,
        {
          isRetryable: err.isRetryable,
          code: err.code,
          status: err.status,
        },
      );
    }
    throw err;
  }
}
