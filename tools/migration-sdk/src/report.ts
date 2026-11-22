import type {
  EnvironmentFlags,
  EnvironmentName,
  PolicyCheckResult,
  QaDeterministicReport,
  SdkQaVerdict,
} from './types.js';

function pad(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

function fmtMs(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'n/a';
  return `${val.toFixed(3)} ms`;
}

function fmtSpeedup(val: number | null | undefined): string {
  if (val === null || val === undefined) return 'n/a';
  return `${val.toFixed(2)}x`;
}

function fmtKbToMb(kb: number | null | undefined): string {
  if (kb === null || kb === undefined) return 'n/a';
  return `${(kb / 1024).toFixed(1)} MB (${kb.toLocaleString()} KB)`;
}

/**
 * Formats the dev / staging / prod feature flag control plane matrix for terminal display.
 */
export function formatFlagsMatrixTerminal(
  allFlags: Record<EnvironmentName, EnvironmentFlags>,
): string {
  const componentIds = new Set<string>();
  for (const env of ['dev', 'staging', 'prod'] as const) {
    for (const id of Object.keys(allFlags[env].components)) {
      componentIds.add(id);
    }
  }

  const lines: string[] = [];
  lines.push('=== Feature Flag Control Plane (config/migration-flags/{dev,staging,prod}.json) ===');
  lines.push(
    `${pad('Component', 18)} | ${pad('dev', 26)} | ${pad('staging', 26)} | ${pad('prod (PROTECTED)', 26)}`,
  );
  lines.push('-'.repeat(106));

  for (const id of [...componentIds].sort()) {
    const fmtCell = (env: EnvironmentName): string => {
      const f = allFlags[env].components[id];
      if (!f) return 'legacy';
      const sample = f.mode === 'shadow' ? ` (${Math.round(f.shadowSampleRate * 100)}%)` : '';
      return `${f.mode} [${f.engine}]${sample}`;
    };
    lines.push(
      `${pad(id, 18)} | ${pad(fmtCell('dev'), 26)} | ${pad(fmtCell('staging'), 26)} | ${pad(fmtCell('prod'), 26)}`,
    );
  }

  return lines.join('\n');
}

/**
 * Formats a concise terminal Before/After QA Scorecard for a component.
 */
export function formatQaScorecardTerminal(
  report: QaDeterministicReport,
  sdkVerdict?: SdkQaVerdict,
): string {
  const lines: string[] = [];
  const overallPass =
    report.passed && (!sdkVerdict || sdkVerdict.verdict !== 'BLOCK');
  const badge = overallPass ? 'PASS_FOR_HUMAN_REVIEW' : 'BLOCK';

  lines.push('');
  lines.push(`=== Migration QA Scorecard: ${report.componentId} (${report.specTitle}) ===`);
  lines.push(`Overall Verdict : ${badge}`);
  lines.push(
    `Golden Parity   : ${report.parity.matchedFiles}/${report.parity.totalFiles} files (${report.parity.parityPercent.toFixed(1)}%)`,
  );

  if (report.cargoTest) {
    lines.push(
      `Cargo Test      : ${report.cargoTest.passed ? 'PASS' : 'FAIL'} (${report.cargoTest.durationMs} ms)`,
    );
  }
  if (report.cargoClippy) {
    lines.push(
      `Cargo Clippy    : ${report.cargoClippy.passed ? 'PASS' : 'FAIL'} (${report.cargoClippy.durationMs} ms)`,
    );
  }

  const b = report.benchmark;
  lines.push('');
  lines.push(`Before vs. After Benchmark (${b.benchmarkFile}, ${b.iterations} iterations):`);
  lines.push(
    `  ${pad('Metric', 22)} | ${pad('Before (Legacy TS)', 24)} | ${pad('After (Rust Core)', 24)} | Delta`,
  );
  lines.push(`  ${'-'.repeat(88)}`);
  lines.push(
    `  ${pad('p50 Latency', 22)} | ${pad(fmtMs(b.legacyP50Ms), 24)} | ${pad(fmtMs(b.rustP50Ms), 24)} | ${fmtSpeedup(b.speedupP50)} faster`,
  );
  lines.push(
    `  ${pad('p95 Latency', 22)} | ${pad(fmtMs(b.legacyP95Ms), 24)} | ${pad(fmtMs(b.rustP95Ms), 24)} | ${fmtSpeedup(b.speedupP95)} faster`,
  );
  lines.push(
    `  ${pad('Peak RSS Memory', 22)} | ${pad(fmtKbToMb(b.legacyPeakRssKb), 24)} | ${pad(fmtKbToMb(b.rustPeakRssKb), 24)} | ${b.rssReductionRatio ? `${b.rssReductionRatio.toFixed(1)}x lower` : 'n/a'}`,
  );
  if (b.rustBinarySizeKb !== null) {
    lines.push(
      `  ${pad('Native CLI Binary', 22)} | ${pad('Node.js + Electron', 24)} | ${pad(fmtKbToMb(b.rustBinarySizeKb), 24)} | native binary`,
    );
  }

  lines.push('');
  lines.push('Policy Guardrails:');
  for (const policy of report.policies) {
    const icon = policy.passed ? '[PASS]' : `[${policy.severity}]`;
    lines.push(`  ${pad(icon, 13)} ${pad(policy.ruleId, 26)} ${policy.message}`);
    if (!policy.passed && policy.details && policy.details.length > 0) {
      for (const detail of policy.details) {
        lines.push(`                -> ${detail}`);
      }
    }
  }

  if (sdkVerdict) {
    lines.push('');
    lines.push(`Phase B — Cursor SDK QA Agent (${sdkVerdict.mode}):`);
    lines.push(`  Verdict : ${sdkVerdict.verdict}`);
    if (sdkVerdict.agentId || sdkVerdict.runId) {
      lines.push(
        `  Run IDs : agentId=${sdkVerdict.agentId ?? 'n/a'} runId=${sdkVerdict.runId ?? 'n/a'} model=${sdkVerdict.modelId ?? 'n/a'}`,
      );
    }
    lines.push(`  Summary : ${sdkVerdict.summary}`);
    if (sdkVerdict.findings.length > 0) {
      lines.push('  Findings:');
      for (const f of sdkVerdict.findings) {
        lines.push(
          `    - [${f.severity.toUpperCase()}] (${f.category}${f.file ? ` @ ${f.file}` : ''}) ${f.message}`,
        );
      }
    }
  }

  return lines.join('\n');
}

/**
 * Formats a GitHub PR comment-ready Markdown Before/After Scorecard.
 */
export function formatQaScorecardMarkdown(
  report: QaDeterministicReport,
  sdkVerdict?: SdkQaVerdict,
): string {
  const overallPass =
    report.passed && (!sdkVerdict || sdkVerdict.verdict !== 'BLOCK');
  const verdictLabel = overallPass ? 'PASS_FOR_HUMAN_REVIEW' : 'BLOCK';
  const b = report.benchmark;

  const lines: string[] = [
    `## MarkText -> MarkText-GPUI Migration QA Scorecard: \`${report.componentId}\``,
    '',
    `**Verdict:** \`${verdictLabel}\` | **Golden Corpus Parity:** ${report.parity.matchedFiles}/${report.parity.totalFiles} (${report.parity.parityPercent.toFixed(1)}%) | **Duration:** ${report.durationMs} ms`,
    '',
    `### Before vs. After Benchmark (\`${b.benchmarkFile}\`, ${b.iterations} iterations)`,
    '',
    '| Metric | Before (Legacy MarkText TS / Node) | After (Rust `marktext-core`) | Delta |',
    '|---|---:|---:|---:|',
    `| p50 Latency | ${fmtMs(b.legacyP50Ms)} | ${fmtMs(b.rustP50Ms)} | **${fmtSpeedup(b.speedupP50)}** |`,
    `| p95 Latency | ${fmtMs(b.legacyP95Ms)} | ${fmtMs(b.rustP95Ms)} | **${fmtSpeedup(b.speedupP95)}** |`,
    `| Mean Latency | ${fmtMs(b.legacyMeanMs)} | ${fmtMs(b.rustMeanMs)} | — |`,
    `| Peak RSS Memory | ${fmtKbToMb(b.legacyPeakRssKb)} | ${fmtKbToMb(b.rustPeakRssKb)} | ${b.rssReductionRatio ? `**${b.rssReductionRatio.toFixed(1)}x lower**` : 'n/a'} |`,
    `| Native CLI Binary Size | Node.js / Electron runtime | ${fmtKbToMb(b.rustBinarySizeKb)} | native |`,
    '',
    '### Golden Corpus Parity Breakdown',
    '',
    '| Fixture | Size | Parity | Legacy p50 | Rust p50 | Speedup |',
    '|---|---:|---|---:|---:|---:|',
    ...report.parity.files.map((f) => {
      const status = f.match ? 'PASS' : `FAIL (${f.diffExcerpt ?? f.rustError ?? 'diff'})`;
      return `| \`${f.file}\` | ${f.bytes.toLocaleString()} B | ${status} | ${fmtMs(f.legacyMetrics.p50Ms)} | ${fmtMs(f.rustMetrics?.p50Ms)} | ${fmtSpeedup(f.speedupP50)} |`;
    }),
    '',
    '### Enterprise Policy Guardrails',
    '',
    '| Rule | Status | Severity | Details |',
    '|---|---|---|---|',
    ...report.policies.map((p: PolicyCheckResult) => {
      const status = p.passed ? 'PASS' : 'FAIL';
      const detailText =
        !p.passed && p.details?.length ? `${p.message} (${p.details.join('; ')})` : p.message;
      return `| \`${p.ruleId}\` | ${status} | \`${p.severity}\` | ${detailText} |`;
    }),
  ];

  if (report.cargoTest || report.cargoClippy) {
    lines.push('', '### Rust Build & Static Verification', '');
    if (report.cargoTest) {
      lines.push(
        `- \`${report.cargoTest.command}\`: **${report.cargoTest.passed ? 'PASS' : 'FAIL'}** (${report.cargoTest.durationMs} ms)`,
      );
    }
    if (report.cargoClippy) {
      lines.push(
        `- \`${report.cargoClippy.command}\`: **${report.cargoClippy.passed ? 'PASS' : 'FAIL'}** (${report.cargoClippy.durationMs} ms)`,
      );
    }
  }

  if (sdkVerdict) {
    lines.push('', `### Phase B — Independent \`@cursor/sdk\` QA Review (\`${sdkVerdict.mode}\`)`, '');
    lines.push(`- **Verdict:** \`${sdkVerdict.verdict}\``);
    if (sdkVerdict.agentId || sdkVerdict.runId) {
      lines.push(
        `- **Traceability:** \`agentId=${sdkVerdict.agentId ?? 'n/a'}\`, \`runId=${sdkVerdict.runId ?? 'n/a'}\`, \`model=${sdkVerdict.modelId ?? 'n/a'}\``,
      );
    }
    lines.push(`- **Summary:** ${sdkVerdict.summary}`);
    if (sdkVerdict.findings.length > 0) {
      lines.push('', '**Findings:**');
      for (const f of sdkVerdict.findings) {
        lines.push(
          `- **[${f.severity.toUpperCase()}]** \`${f.category}\`${f.file ? ` (\`${f.file}\`)` : ''}: ${f.message}`,
        );
      }
    }
    if (sdkVerdict.recommendedActions.length > 0) {
      lines.push('', '**Recommended Actions:**');
      for (const a of sdkVerdict.recommendedActions) {
        lines.push(`- ${a}`);
      }
    }
  }

  lines.push(
    '',
    '---',
    '_Human approval via `.github/CODEOWNERS` is strictly required before merging any migration PR or promoting `config/migration-flags/prod.json`._',
    '',
  );

  return lines.join('\n');
}
