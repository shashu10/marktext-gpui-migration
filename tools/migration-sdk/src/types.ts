export type EnvironmentName = 'dev' | 'staging' | 'prod';

export type FlagMode = 'legacy' | 'shadow' | 'migrated';

export type EngineKind = 'legacy-ts' | 'rust-core';

export type KnownComponentId = 'word-count' | 'outline-toc' | 'markdown-blocks';

export interface MigrationPerfBudget {
  minSpeedupRatio: number;
  maxP95Ms: number;
  requireExactParity: boolean;
}

export interface MigrationSpec {
  componentId: string;
  title: string;
  status: 'migrated' | 'shadow' | 'pending' | 'legacy';
  legacySource: string;
  legacyHarnessEntry: string;
  rustModule: string;
  rustSubcommand: string;
  gpuiView: string;
  corpusDir: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  perfBudget: MigrationPerfBudget;
  acceptanceCriteria: string[];
}

export interface ComponentFlag {
  mode: FlagMode;
  engine: EngineKind;
  shadowSampleRate: number;
  fallbackOnError: boolean;
}

export interface EnvironmentFlags {
  environment: EnvironmentName;
  description?: string;
  components: Record<string, ComponentFlag>;
}

export interface WordCountResult {
  word: number;
  paragraph: number;
  character: number;
  all: number;
}

export interface OutlineHeading {
  line: number;
  level: number;
  text: string;
  githubSlug: string;
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code_fence'; lang: string; code: string }
  | { kind: 'task_item'; checked: boolean; text: string }
  | { kind: 'blockquote'; text: string }
  | { kind: 'hr' }
  | { kind: 'paragraph'; text: string };

export interface EngineMetrics {
  iterations: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  peakRssKb: number;
}

export interface ComponentRunResult<T = unknown> {
  component: string;
  engine: EngineKind;
  output: T;
  metrics: EngineMetrics;
}

export interface RouterTelemetry<T = unknown> {
  environment: EnvironmentName;
  componentId: string;
  mode: FlagMode;
  activeEngine: EngineKind;
  result: T;
  legacyMs?: number;
  rustMs?: number;
  shadowCompared?: boolean;
  shadowParityMatch?: boolean;
  shadowDiffExcerpt?: string;
  fellBackToLegacy: boolean;
  rustError?: string;
}

export interface ParityFileResult {
  file: string;
  bytes: number;
  match: boolean;
  legacyMetrics: EngineMetrics;
  rustMetrics?: EngineMetrics;
  speedupP50?: number;
  speedupP95?: number;
  diffExcerpt?: string;
  rustError?: string;
}

export interface ParitySummary {
  totalFiles: number;
  matchedFiles: number;
  mismatchedFiles: number;
  parityPercent: number;
  exactMatch: boolean;
  files: ParityFileResult[];
}

export interface BenchmarkComparison {
  benchmarkFile: string;
  iterations: number;
  legacyP50Ms: number;
  legacyP95Ms: number;
  legacyMeanMs: number;
  legacyPeakRssKb: number;
  rustP50Ms: number | null;
  rustP95Ms: number | null;
  rustMeanMs: number | null;
  rustPeakRssKb: number | null;
  speedupP50: number | null;
  speedupP95: number | null;
  rssReductionRatio: number | null;
  rustBinarySizeKb: number | null;
}

export type PolicySeverity = 'HARD_BLOCK' | 'BLOCK' | 'WARN';

export interface PolicyCheckResult {
  ruleId: string;
  passed: boolean;
  severity: PolicySeverity;
  message: string;
  details?: string[];
}

export interface CargoCheckResult {
  executed: boolean;
  passed: boolean;
  durationMs: number;
  command: string;
  outputExcerpt?: string;
}

export interface QaDeterministicReport {
  timestamp: string;
  componentId: string;
  specTitle: string;
  baseRef?: string;
  changedFiles: string[];
  cargoTest?: CargoCheckResult;
  cargoClippy?: CargoCheckResult;
  parity: ParitySummary;
  benchmark: BenchmarkComparison;
  policies: PolicyCheckResult[];
  passed: boolean;
  durationMs: number;
}

export interface SdkQaFinding {
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  category: string;
  file?: string;
  message: string;
}

export interface SdkQaVerdict {
  mode: 'live-sdk' | 'deterministic-only';
  verdict: 'PASS_FOR_HUMAN_REVIEW' | 'BLOCK' | 'SKIPPED';
  summary: string;
  findings: SdkQaFinding[];
  recommendedActions: string[];
  agentId?: string;
  runId?: string;
  modelId?: string;
  durationMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  skipReason?: string;
}

export interface EvalRunRecord {
  id: string;
  timestamp: string;
  kind: 'qa' | 'dispatch' | 'demo';
  componentId: string;
  mode: 'live-sdk' | 'deterministic-only' | 'dry-run';
  status: 'passed' | 'blocked' | 'startup_error' | 'run_error';
  exitCode: 0 | 1 | 2;
  durationMs: number;
  agentId?: string;
  runId?: string;
  prUrl?: string;
  deterministic?: QaDeterministicReport;
  sdkVerdict?: SdkQaVerdict;
  metadata?: Record<string, unknown>;
}
