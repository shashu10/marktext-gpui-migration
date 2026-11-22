import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { resolveRepoRoot } from './paths.js';
import type {
  ComponentFlag,
  EnvironmentFlags,
  EnvironmentName,
  RouterTelemetry,
} from './types.js';

export const ALL_ENVIRONMENTS: readonly EnvironmentName[] = ['dev', 'staging', 'prod'] as const;

export function loadEnvironmentFlags(
  env: EnvironmentName,
  repoRoot: string = resolveRepoRoot(),
): EnvironmentFlags {
  const flagPath = path.join(repoRoot, 'config', 'migration-flags', `${env}.json`);
  if (!fs.existsSync(flagPath)) {
    throw new Error(`Feature flag config not found for environment "${env}" at ${flagPath}`);
  }
  const raw = fs.readFileSync(flagPath, 'utf8');
  return JSON.parse(raw) as EnvironmentFlags;
}

export function loadAllEnvironmentFlags(
  repoRoot: string = resolveRepoRoot(),
): Record<EnvironmentName, EnvironmentFlags> {
  return {
    dev: loadEnvironmentFlags('dev', repoRoot),
    staging: loadEnvironmentFlags('staging', repoRoot),
    prod: loadEnvironmentFlags('prod', repoRoot),
  };
}

export function getComponentFlag(
  env: EnvironmentName,
  componentId: string,
  repoRoot: string = resolveRepoRoot(),
): ComponentFlag {
  const config = loadEnvironmentFlags(env, repoRoot);
  const flag = config.components[componentId];
  if (!flag) {
    return {
      mode: 'legacy',
      engine: 'legacy-ts',
      shadowSampleRate: 0,
      fallbackOnError: true,
    };
  }
  return flag;
}

/**
 * Deterministic deep equality comparison + concise first-difference excerpt.
 */
export function deepCompare(
  legacyVal: unknown,
  rustVal: unknown,
  currentPath = '$',
): { equal: boolean; diffExcerpt?: string } {
  if (Object.is(legacyVal, rustVal)) {
    return { equal: true };
  }

  if (
    typeof legacyVal !== typeof rustVal ||
    legacyVal === null ||
    rustVal === null ||
    Array.isArray(legacyVal) !== Array.isArray(rustVal)
  ) {
    return {
      equal: false,
      diffExcerpt: `${currentPath}: legacy=${JSON.stringify(legacyVal)} vs rust=${JSON.stringify(rustVal)}`,
    };
  }

  if (Array.isArray(legacyVal) && Array.isArray(rustVal)) {
    if (legacyVal.length !== rustVal.length) {
      return {
        equal: false,
        diffExcerpt: `${currentPath}.length: legacy=${legacyVal.length} vs rust=${rustVal.length}`,
      };
    }
    for (let i = 0; i < legacyVal.length; i++) {
      const cmp = deepCompare(legacyVal[i], rustVal[i], `${currentPath}[${i}]`);
      if (!cmp.equal) return cmp;
    }
    return { equal: true };
  }

  if (typeof legacyVal === 'object' && typeof rustVal === 'object') {
    const legacyObj = legacyVal as Record<string, unknown>;
    const rustObj = rustVal as Record<string, unknown>;
    const keys = new Set([...Object.keys(legacyObj), ...Object.keys(rustObj)]);
    for (const key of keys) {
      if (!(key in legacyObj)) {
        return {
          equal: false,
          diffExcerpt: `${currentPath}.${key}: missing in legacy, rust=${JSON.stringify(rustObj[key])}`,
        };
      }
      if (!(key in rustObj)) {
        return {
          equal: false,
          diffExcerpt: `${currentPath}.${key}: legacy=${JSON.stringify(legacyObj[key])}, missing in rust`,
        };
      }
      const cmp = deepCompare(legacyObj[key], rustObj[key], `${currentPath}.${key}`);
      if (!cmp.equal) return cmp;
    }
    return { equal: true };
  }

  return {
    equal: false,
    diffExcerpt: `${currentPath}: legacy=${JSON.stringify(legacyVal)} vs rust=${JSON.stringify(rustVal)}`,
  };
}

export interface FeatureFlagRouterOptions {
  /** Optional explicit flag override (useful for unit tests and live demos). */
  flagOverride?: ComponentFlag;
  /** Optional deterministic RNG in [0, 1) for shadowSampleRate sampling. */
  randomFn?: () => number;
  repoRoot?: string;
}

/**
 * Strangler-Fig Router:
 * - `legacy`: executes `legacyFn` only.
 * - `shadow`: executes `legacyFn` AND (according to `shadowSampleRate`) `rustFn`,
 *   deep-diffs outputs, records parity match/mismatch + latency delta, and ALWAYS
 *   returns the `legacyFn` result (gracefully catching Rust errors when `fallbackOnError` is true).
 * - `migrated`: executes `rustFn`; if Rust throws and `fallbackOnError` is true,
 *   gracefully falls back to `legacyFn` and records `fellBackToLegacy: true`.
 */
export async function runWithFeatureFlag<T>(
  env: EnvironmentName,
  componentId: string,
  legacyFn: () => T | Promise<T>,
  rustFn: () => T | Promise<T>,
  options: FeatureFlagRouterOptions = {},
): Promise<RouterTelemetry<T>> {
  const flag =
    options.flagOverride ?? getComponentFlag(env, componentId, options.repoRoot);

  if (flag.mode === 'legacy') {
    const t0 = performance.now();
    const result = await legacyFn();
    const legacyMs = performance.now() - t0;
    return {
      environment: env,
      componentId,
      mode: 'legacy',
      activeEngine: 'legacy-ts',
      result,
      legacyMs,
      fellBackToLegacy: false,
    };
  }

  if (flag.mode === 'shadow') {
    const tLegacy0 = performance.now();
    const legacyResult = await legacyFn();
    const legacyMs = performance.now() - tLegacy0;

    const sampleRoll = (options.randomFn ?? Math.random)();
    if (sampleRoll >= flag.shadowSampleRate) {
      return {
        environment: env,
        componentId,
        mode: 'shadow',
        activeEngine: 'legacy-ts',
        result: legacyResult,
        legacyMs,
        shadowCompared: false,
        fellBackToLegacy: false,
      };
    }

    const tRust0 = performance.now();
    try {
      const rustResult = await rustFn();
      const rustMs = performance.now() - tRust0;
      const cmp = deepCompare(legacyResult, rustResult);
      return {
        environment: env,
        componentId,
        mode: 'shadow',
        activeEngine: 'legacy-ts',
        result: legacyResult,
        legacyMs,
        rustMs,
        shadowCompared: true,
        shadowParityMatch: cmp.equal,
        shadowDiffExcerpt: cmp.diffExcerpt,
        fellBackToLegacy: false,
      };
    } catch (err) {
      const rustMs = performance.now() - tRust0;
      const message = err instanceof Error ? err.message : String(err);
      if (!flag.fallbackOnError) {
        throw err;
      }
      return {
        environment: env,
        componentId,
        mode: 'shadow',
        activeEngine: 'legacy-ts',
        result: legacyResult,
        legacyMs,
        rustMs,
        shadowCompared: true,
        shadowParityMatch: false,
        shadowDiffExcerpt: `rust engine error: ${message}`,
        fellBackToLegacy: false,
        rustError: message,
      };
    }
  }

  // mode === 'migrated'
  const tRust0 = performance.now();
  try {
    const rustResult = await rustFn();
    const rustMs = performance.now() - tRust0;
    return {
      environment: env,
      componentId,
      mode: 'migrated',
      activeEngine: 'rust-core',
      result: rustResult,
      rustMs,
      fellBackToLegacy: false,
    };
  } catch (err) {
    const rustMs = performance.now() - tRust0;
    const message = err instanceof Error ? err.message : String(err);
    if (!flag.fallbackOnError) {
      throw err;
    }
    const tLegacy0 = performance.now();
    const legacyResult = await legacyFn();
    const legacyMs = performance.now() - tLegacy0;
    return {
      environment: env,
      componentId,
      mode: 'migrated',
      activeEngine: 'legacy-ts',
      result: legacyResult,
      legacyMs,
      rustMs,
      fellBackToLegacy: true,
      rustError: message,
    };
  }
}
