import type {
  BenchmarkComparison,
  MigrationSpec,
  ParitySummary,
  PolicyCheckResult,
} from '../types.js';

export interface PolicyEvaluationContext {
  spec: MigrationSpec;
  changedFiles: string[];
  parity: ParitySummary;
  benchmark: BenchmarkComparison;
  allowProdPromotion?: boolean;
  enforceAllowedPathScope?: boolean;
}

export type PolicyRule = (ctx: PolicyEvaluationContext) => PolicyCheckResult;

function normalizeRepoPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function matchesPathPattern(filePath: string, pattern: string): boolean {
  const normFile = normalizeRepoPath(filePath);
  const normPattern = normalizeRepoPath(pattern);
  if (normPattern.endsWith('/')) {
    return normFile.startsWith(normPattern);
  }
  return normFile === normPattern || normFile.startsWith(`${normPattern}/`);
}

/**
 * Policy 1: HARD BLOCK any modification to `config/migration-flags/prod.json`
 * unless explicitly authorized via `--allow-prod-promotion`.
 */
export const noProdFlagMutationRule: PolicyRule = (ctx) => {
  const prodFlagPath = 'config/migration-flags/prod.json';
  const touched = ctx.changedFiles
    .map(normalizeRepoPath)
    .filter((f) => f === prodFlagPath);

  if (touched.length > 0 && !ctx.allowProdPromotion) {
    return {
      ruleId: 'no-prod-flag-mutation',
      passed: false,
      severity: 'HARD_BLOCK',
      message:
        'Production feature flags (config/migration-flags/prod.json) cannot be modified in an automated migration PR without explicit --allow-prod-promotion human approval.',
      details: touched,
    };
  }

  return {
    ruleId: 'no-prod-flag-mutation',
    passed: true,
    severity: 'HARD_BLOCK',
    message:
      touched.length > 0
        ? 'Production flag promotion explicitly authorized via --allow-prod-promotion.'
        : 'Production feature flags untouched.',
  };
};

/**
 * Policy 2: HARD BLOCK any tampering with governance files (`.github/CODEOWNERS` or `.github/workflows/`).
 */
export const noGovernanceTamperingRule: PolicyRule = (ctx) => {
  const governancePatterns = ['.github/CODEOWNERS', '.github/workflows/'];
  const violations = ctx.changedFiles
    .map(normalizeRepoPath)
    .filter((file) => governancePatterns.some((pat) => matchesPathPattern(file, pat)));

  if (violations.length > 0) {
    return {
      ruleId: 'no-governance-tampering',
      passed: false,
      severity: 'HARD_BLOCK',
      message:
        'Migration PRs must not modify repository governance files (.github/CODEOWNERS or .github/workflows/).',
      details: violations,
    };
  }

  return {
    ruleId: 'no-governance-tampering',
    passed: true,
    severity: 'HARD_BLOCK',
    message: 'Governance files (.github/CODEOWNERS, .github/workflows/) untouched.',
  };
};

/**
 * Policy 3: HARD BLOCK modifying or deleting any forbidden legacy path declared in `spec.forbiddenPaths`.
 */
export const preserveLegacyPathRule: PolicyRule = (ctx) => {
  const forbidden = ctx.spec.forbiddenPaths.filter((p) => {
    const norm = normalizeRepoPath(p);
    return norm !== 'config/migration-flags/prod.json' || !ctx.allowProdPromotion;
  });

  const violations = ctx.changedFiles
    .map(normalizeRepoPath)
    .filter((file) => forbidden.some((pat) => matchesPathPattern(file, pat)));

  if (violations.length > 0) {
    return {
      ruleId: 'preserve-legacy-path',
      passed: false,
      severity: 'HARD_BLOCK',
      message: `Strangler-fig invariant violated: forbidden legacy/protected path modified (${violations.join(', ')}).`,
      details: violations,
    };
  }

  return {
    ruleId: 'preserve-legacy-path',
    passed: true,
    severity: 'HARD_BLOCK',
    message: 'All legacy fallback implementations and forbidden paths preserved.',
  };
};

/**
 * Policy 4: BLOCK if branch diff modifies files outside `spec.allowedPaths`.
 */
export const allowedPathScopeRule: PolicyRule = (ctx) => {
  if (!ctx.enforceAllowedPathScope || ctx.changedFiles.length === 0) {
    return {
      ruleId: 'allowed-path-scope',
      passed: true,
      severity: 'BLOCK',
      message:
        ctx.changedFiles.length === 0
          ? 'No branch file changes detected to scope-check.'
          : 'Allowed-path scope enforcement skipped (no --base branch diff).',
    };
  }

  const outOfScope = ctx.changedFiles
    .map(normalizeRepoPath)
    .filter((file) => !ctx.spec.allowedPaths.some((pat) => matchesPathPattern(file, pat)));

  if (outOfScope.length > 0) {
    return {
      ruleId: 'allowed-path-scope',
      passed: false,
      severity: 'BLOCK',
      message: `Modified file(s) outside migrations/${ctx.spec.componentId}.json allowedPaths.`,
      details: outOfScope,
    };
  }

  return {
    ruleId: 'allowed-path-scope',
    passed: true,
    severity: 'BLOCK',
    message: `All ${ctx.changedFiles.length} changed file(s) stay within allowedPaths.`,
  };
};

/**
 * Policy 5: BLOCK if `spec.perfBudget.requireExactParity` is true and parity < 100%.
 */
export const exactParityRequiredRule: PolicyRule = (ctx) => {
  if (!ctx.spec.perfBudget.requireExactParity) {
    return {
      ruleId: 'exact-parity-required',
      passed: true,
      severity: 'BLOCK',
      message: 'Exact parity not required by migration spec.',
    };
  }

  if (ctx.parity.totalFiles === 0) {
    return {
      ruleId: 'exact-parity-required',
      passed: false,
      severity: 'BLOCK',
      message: 'Golden corpus contained 0 files; cannot certify parity.',
    };
  }

  if (!ctx.parity.exactMatch) {
    const failedFiles = ctx.parity.files
      .filter((f) => !f.match)
      .map((f) => `${f.file}: ${f.diffExcerpt ?? f.rustError ?? 'mismatch'}`);
    return {
      ruleId: 'exact-parity-required',
      passed: false,
      severity: 'BLOCK',
      message: `Golden corpus parity is ${ctx.parity.parityPercent.toFixed(1)}% (${ctx.parity.matchedFiles}/${ctx.parity.totalFiles}); 100% exact parity is required.`,
      details: failedFiles,
    };
  }

  return {
    ruleId: 'exact-parity-required',
    passed: true,
    severity: 'BLOCK',
    message: `100.0% exact parity across all ${ctx.parity.totalFiles} golden corpus files.`,
  };
};

/**
 * Policy 6: BLOCK if Rust p95 exceeds `maxP95Ms` or speedup ratio < `minSpeedupRatio`
 * on the large benchmark fixture.
 */
export const perfBudgetGateRule: PolicyRule = (ctx) => {
  const { maxP95Ms, minSpeedupRatio } = ctx.spec.perfBudget;
  const { rustP95Ms, speedupP50, speedupP95, benchmarkFile } = ctx.benchmark;

  if (rustP95Ms === null) {
    return {
      ruleId: 'perf-budget-gate',
      passed: false,
      severity: 'BLOCK',
      message: `Rust benchmark did not execute on ${benchmarkFile}; cannot verify performance budget.`,
    };
  }

  const violations: string[] = [];
  if (rustP95Ms > maxP95Ms) {
    violations.push(`Rust p95 ${rustP95Ms.toFixed(3)}ms exceeds maxP95Ms budget (${maxP95Ms}ms)`);
  }

  const effectiveSpeedup = speedupP50 ?? speedupP95;
  if (effectiveSpeedup !== null && effectiveSpeedup < minSpeedupRatio) {
    violations.push(
      `Speedup ${effectiveSpeedup.toFixed(2)}x is below minSpeedupRatio budget (${minSpeedupRatio}x)`,
    );
  }

  if (violations.length > 0) {
    return {
      ruleId: 'perf-budget-gate',
      passed: false,
      severity: 'BLOCK',
      message: `Performance budget gate failed on ${benchmarkFile}.`,
      details: violations,
    };
  }

  return {
    ruleId: 'perf-budget-gate',
    passed: true,
    severity: 'BLOCK',
    message: `Within budget on ${benchmarkFile}: Rust p95=${rustP95Ms.toFixed(3)}ms (<= ${maxP95Ms}ms), speedup=${effectiveSpeedup !== null ? `${effectiveSpeedup.toFixed(2)}x` : 'n/a'} (>= ${minSpeedupRatio}x).`,
  };
};

/**
 * Live-extension seam: add new enterprise policy guardrails to this array.
 */
export const DEFAULT_POLICY_RULES: readonly PolicyRule[] = [
  noProdFlagMutationRule,
  noGovernanceTamperingRule,
  preserveLegacyPathRule,
  allowedPathScopeRule,
  exactParityRequiredRule,
  perfBudgetGateRule,
] as const;

export function evaluatePolicies(
  ctx: PolicyEvaluationContext,
  rules: readonly PolicyRule[] = DEFAULT_POLICY_RULES,
): PolicyCheckResult[] {
  return rules.map((rule) => rule(ctx));
}
