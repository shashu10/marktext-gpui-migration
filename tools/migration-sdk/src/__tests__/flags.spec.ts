import { describe, expect, it, vi } from 'vitest';
import { loadAllEnvironmentFlags, runWithFeatureFlag } from '../flags.js';

describe('strangler-fig feature flag router', () => {
  it('loads dev, staging, and prod flag configs from repo root', () => {
    const all = loadAllEnvironmentFlags();
    expect(all.dev.environment).toBe('dev');
    expect(all.staging.environment).toBe('staging');
    expect(all.prod.environment).toBe('prod');
    expect(all.dev.components['word-count']?.mode).toBe('migrated');
    expect(all.staging.components['outline-toc']?.mode).toBe('shadow');
    expect(all.prod.components['markdown-blocks']?.mode).toBe('legacy');
  });

  it('runs only legacyFn in legacy mode', async () => {
    const legacyFn = vi.fn(() => ({ word: 2 }));
    const rustFn = vi.fn(() => ({ word: 999 }));

    const telemetry = await runWithFeatureFlag('prod', 'markdown-blocks', legacyFn, rustFn, {
      flagOverride: {
        mode: 'legacy',
        engine: 'legacy-ts',
        shadowSampleRate: 0,
        fallbackOnError: true,
      },
    });

    expect(legacyFn).toHaveBeenCalledTimes(1);
    expect(rustFn).not.toHaveBeenCalled();
    expect(telemetry.activeEngine).toBe('legacy-ts');
    expect(telemetry.result).toEqual({ word: 2 });
    expect(telemetry.fellBackToLegacy).toBe(false);
  });

  it('runs both engines in shadow mode, detects parity mismatch, and returns legacy result', async () => {
    const legacyFn = vi.fn(() => ({ word: 10, paragraph: 2 }));
    const rustFn = vi.fn(() => ({ word: 11, paragraph: 2 }));

    const telemetry = await runWithFeatureFlag('staging', 'outline-toc', legacyFn, rustFn, {
      flagOverride: {
        mode: 'shadow',
        engine: 'legacy-ts',
        shadowSampleRate: 1.0,
        fallbackOnError: true,
      },
      randomFn: () => 0.1,
    });

    expect(legacyFn).toHaveBeenCalledTimes(1);
    expect(rustFn).toHaveBeenCalledTimes(1);
    expect(telemetry.activeEngine).toBe('legacy-ts');
    expect(telemetry.result).toEqual({ word: 10, paragraph: 2 });
    expect(telemetry.shadowCompared).toBe(true);
    expect(telemetry.shadowParityMatch).toBe(false);
    expect(telemetry.shadowDiffExcerpt).toContain('$.word');
    expect(telemetry.fellBackToLegacy).toBe(false);
  });

  it('catches Rust errors gracefully in shadow mode when fallbackOnError is true', async () => {
    const legacyFn = vi.fn(() => ['ok']);
    const rustFn = vi.fn(() => {
      throw new Error('NOT_MIGRATED');
    });

    const telemetry = await runWithFeatureFlag('staging', 'markdown-blocks', legacyFn, rustFn, {
      flagOverride: {
        mode: 'shadow',
        engine: 'legacy-ts',
        shadowSampleRate: 1.0,
        fallbackOnError: true,
      },
      randomFn: () => 0,
    });

    expect(telemetry.result).toEqual(['ok']);
    expect(telemetry.shadowParityMatch).toBe(false);
    expect(telemetry.rustError).toBe('NOT_MIGRATED');
  });

  it('runs rustFn in migrated mode and falls back gracefully to legacyFn on error when fallbackOnError is true', async () => {
    const legacyFn = vi.fn(() => ({ ok: 'legacy-fallback' }));
    const rustFn = vi.fn(() => {
      throw new Error('Component not migrated');
    });

    const telemetry = await runWithFeatureFlag('dev', 'markdown-blocks', legacyFn, rustFn, {
      flagOverride: {
        mode: 'migrated',
        engine: 'rust-core',
        shadowSampleRate: 0,
        fallbackOnError: true,
      },
    });

    expect(rustFn).toHaveBeenCalledTimes(1);
    expect(legacyFn).toHaveBeenCalledTimes(1);
    expect(telemetry.activeEngine).toBe('legacy-ts');
    expect(telemetry.result).toEqual({ ok: 'legacy-fallback' });
    expect(telemetry.fellBackToLegacy).toBe(true);
    expect(telemetry.rustError).toBe('Component not migrated');
  });

  it('rethrows Rust error in migrated mode when fallbackOnError is false', async () => {
    const legacyFn = vi.fn(() => ({ ok: 'legacy' }));
    const rustFn = vi.fn(() => {
      throw new Error('fatal rust failure');
    });

    await expect(
      runWithFeatureFlag('dev', 'word-count', legacyFn, rustFn, {
        flagOverride: {
          mode: 'migrated',
          engine: 'rust-core',
          shadowSampleRate: 0,
          fallbackOnError: false,
        },
      }),
    ).rejects.toThrow('fatal rust failure');
    expect(legacyFn).not.toHaveBeenCalled();
  });
});
