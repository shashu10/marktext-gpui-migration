import { Agent, CursorAgentError, type AgentOptions } from '@cursor/sdk';
import { performance } from 'node:perf_hooks';
import { loadEnvConfig, loadMigrationSpec, resolveRepoRoot, writeEvalRunRecord } from './paths.js';
import { SdkRunExecutionError, SdkStartupError } from './qa/sdk-reviewer.js';
import type { EvalRunRecord, MigrationSpec } from './types.js';

export interface DispatchOptions {
  componentId: string;
  repo: string;
  branch?: string;
  dryRun?: boolean;
  modelId?: string;
  repoRoot?: string;
  onLog?: (line: string) => void;
}

export interface DispatchResult {
  dryRun: boolean;
  componentId: string;
  repoUrl: string;
  startingRef: string;
  agentId?: string;
  runId?: string;
  status: 'dry-run' | 'finished';
  prUrl?: string;
  branch?: string;
  summary?: string;
  durationMs: number;
  recordPath: string;
  payloadPreview?: {
    agentOptions: Omit<AgentOptions, 'apiKey'> & { apiKey: string };
    prompt: string;
  };
}

export function normalizeRepoUrl(repo: string): string {
  const trimmed = repo.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const cleaned = trimmed.replace(/^github\.com\//i, '').replace(/\.git$/i, '');
  return `https://github.com/${cleaned}`;
}

export function buildMigrationPrompt(spec: MigrationSpec): string {
  return [
    `# Incremental Migration Task: ${spec.componentId} (${spec.title})`,
    '',
    'You are executing an incremental MarkText -> MarkText-GPUI strangler-fig migration inside a Cursor Cloud Agent VM.',
    '',
    '## Contract & References',
    `- **Legacy reference implementation:** \`${spec.legacySource}\` (DO NOT modify or delete)`,
    `- **Target Rust module:** \`${spec.rustModule}\``,
    `- **CLI parity subcommand:** \`marktext-core-cli ${spec.rustSubcommand} --input <file> --iterations <N>\``,
    `- **GPUI view integration:** \`${spec.gpuiView}\``,
    `- **Golden parity corpus:** \`${spec.corpusDir}/\``,
    '',
    '## Acceptance Criteria',
    ...spec.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    '## Performance & Parity Budgets',
    `- Require exact 100% JSON parity on every file in \`${spec.corpusDir}/\`: \`${spec.perfBudget.requireExactParity}\``,
    `- Max Rust p95 latency on large benchmark fixture: \`<= ${spec.perfBudget.maxP95Ms} ms\``,
    `- Minimum speedup over legacy TS: \`>= ${spec.perfBudget.minSpeedupRatio}x\``,
    '',
    '## Hard Governance Guardrails (Enforced by Independent QA Gate)',
    `- ONLY edit files within allowedPaths: ${spec.allowedPaths.map((p) => `\`${p}\``).join(', ')}`,
    `- NEVER touch forbiddenPaths: ${spec.forbiddenPaths.map((p) => `\`${p}\``).join(', ')}`,
    '- NEVER edit `config/migration-flags/prod.json`, `.github/CODEOWNERS`, or `.github/workflows/`.',
    '- Preserve the legacy TypeScript fallback path intact.',
    '',
    '## Verification Commands to Run Before Opening PR',
    '1. `cargo test --workspace --manifest-path rust/Cargo.toml`',
    '2. `cargo clippy --workspace --all-targets --manifest-path rust/Cargo.toml -- -D warnings`',
    '3. `cargo build --release --manifest-path rust/Cargo.toml --bin marktext-core-cli`',
    `4. \`pnpm --dir tools/migration-sdk qa -- --component ${spec.componentId} --deterministic-only\``,
    '',
    'Open the PR with label `migration` and include the verification summary in the PR description.',
  ].join('\n');
}

/**
 * Dispatches a Cursor Cloud Agent via `@cursor/sdk` to implement a component
 * migration spec and open a PR (`autoCreatePR: true`, `skipReviewerRequest: true`).
 */
export async function dispatchCloudMigration(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const t0 = performance.now();
  const log = options.onLog ?? ((line: string) => console.log(line));
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const spec = loadMigrationSpec(options.componentId, repoRoot);
  const envCfg = loadEnvConfig(repoRoot);
  const modelId = options.modelId ?? envCfg.modelId;
  const repoUrl = normalizeRepoUrl(options.repo);
  const startingRef = options.branch?.trim() || 'main';
  const prompt = buildMigrationPrompt(spec);

  const cloudOptions: NonNullable<AgentOptions['cloud']> = {
    repos: [
      {
        url: repoUrl,
        startingRef,
      },
    ],
    autoCreatePR: true,
    skipReviewerRequest: true,
    metadata: {
      componentId: spec.componentId,
      workflow: 'marktext-gpui-migration',
    },
  };

  if (options.dryRun) {
    const durationMs = Math.round(performance.now() - t0);
    const payloadPreview = {
      agentOptions: {
        apiKey: envCfg.apiKey ? '***REDACTED***' : '<CURSOR_API_KEY required for live run>',
        model: { id: modelId },
        name: `migrate-${spec.componentId}`,
        cloud: cloudOptions,
      },
      prompt,
    };

    log(`[DRY RUN] Cloud Agent API NOT called.`);
    log(`[DRY RUN] Component: ${spec.componentId} (${spec.title})`);
    log(`[DRY RUN] Repo: ${repoUrl} (startingRef=${startingRef})`);
    log(`[DRY RUN] Agent.create payload:\n${JSON.stringify(payloadPreview.agentOptions, null, 2)}`);
    log(`[DRY RUN] Migration prompt (${prompt.length} chars):\n---\n${prompt}\n---`);

    const record: EvalRunRecord = {
      id: `dispatch-dryrun-${Date.now()}`,
      timestamp: new Date().toISOString(),
      kind: 'dispatch',
      componentId: spec.componentId,
      mode: 'dry-run',
      status: 'passed',
      exitCode: 0,
      durationMs,
      metadata: {
        repoUrl,
        startingRef,
        modelId,
        autoCreatePR: true,
        skipReviewerRequest: true,
        dryRun: true,
      },
    };
    const recordPath = writeEvalRunRecord(record, repoRoot);

    return {
      dryRun: true,
      componentId: spec.componentId,
      repoUrl,
      startingRef,
      status: 'dry-run',
      durationMs,
      recordPath,
      payloadPreview,
    };
  }

  if (!envCfg.apiKey) {
    throw new SdkStartupError(
      'Missing CURSOR_API_KEY. Set CURSOR_API_KEY in environment or repo-root .env, or pass --dry-run to preview the Cloud Agent dispatch payload.',
      { isRetryable: false, code: 'MISSING_API_KEY' },
    );
  }

  try {
    // Guardrail 1 & 2 & 6 & 7: Explicit cloud runtime, explicit apiKey, await using disposal,
    // autoCreatePR: true, skipReviewerRequest: true, no agent.summarize() on cloud.
    await using agent = await Agent.create({
      apiKey: envCfg.apiKey,
      model: { id: modelId },
      name: `migrate-${spec.componentId}`,
      cloud: cloudOptions,
    });

    const run = await agent.send(prompt);
    // Guardrail 5: Log IDs immediately after send() before streaming/waiting
    log(
      `[Cursor Cloud Agent] Dispatched component=${spec.componentId} agentId=${agent.agentId} runId=${run.id} repo=${repoUrl}@${startingRef}`,
    );

    const assistantChunks: string[] = [];
    if (run.supports('stream')) {
      for await (const event of run.stream()) {
        if (event.type === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              assistantChunks.push(block.text);
              log(`[Cloud Agent] ${block.text.trim()}`);
            }
          }
        } else if (event.type === 'status') {
          log(`[Cloud Agent Status] ${event.status}${event.message ? ` — ${event.message}` : ''}`);
        } else if (event.type === 'summary') {
          log(
            `[Cloud Agent Summary] status=${event.status}${event.fallback === true ? ' (fallback)' : ''}`,
          );
        }
      }
    }

    // Guardrail 3: Always await run.wait()
    const result = await run.wait();
    const durationMs = Math.round(performance.now() - t0);
    const branchInfo = result.git?.branches?.[0];
    const prUrl = branchInfo?.prUrl;

    if (result.status !== 'finished') {
      const record: EvalRunRecord = {
        id: `dispatch-${run.id}`,
        timestamp: new Date().toISOString(),
        kind: 'dispatch',
        componentId: spec.componentId,
        mode: 'live-sdk',
        status: 'run_error',
        exitCode: 2,
        durationMs,
        agentId: agent.agentId,
        runId: run.id,
        prUrl,
        metadata: {
          repoUrl,
          startingRef,
          modelId,
          runStatus: result.status,
          error: result.error,
        },
      };
      writeEvalRunRecord(record, repoRoot);

      throw new SdkRunExecutionError(
        `Cloud Agent run ended with status="${result.status}"${result.error ? `: ${result.error.message}` : ''}`,
        agent.agentId,
        run.id,
        result.status,
      );
    }

    const summary = (result.result ?? assistantChunks.join('\n')).trim();
    const record: EvalRunRecord = {
      id: `dispatch-${run.id}`,
      timestamp: new Date().toISOString(),
      kind: 'dispatch',
      componentId: spec.componentId,
      mode: 'live-sdk',
      status: 'passed',
      exitCode: 0,
      durationMs,
      agentId: agent.agentId,
      runId: run.id,
      prUrl,
      metadata: {
        repoUrl,
        startingRef,
        modelId,
        branch: branchInfo?.branch,
        usage: result.usage,
      },
    };
    const recordPath = writeEvalRunRecord(record, repoRoot);

    return {
      dryRun: false,
      componentId: spec.componentId,
      repoUrl,
      startingRef,
      agentId: agent.agentId,
      runId: run.id,
      status: 'finished',
      prUrl,
      branch: branchInfo?.branch,
      summary,
      durationMs,
      recordPath,
    };
  } catch (err) {
    if (err instanceof SdkRunExecutionError || err instanceof SdkStartupError) {
      throw err;
    }
    if (err instanceof CursorAgentError) {
      throw new SdkStartupError(
        `Cursor Cloud Agent startup error (${err.code ?? 'SDK_ERROR'}, retryable=${err.isRetryable}): ${err.message}`,
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
