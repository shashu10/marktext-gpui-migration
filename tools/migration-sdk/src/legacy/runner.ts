import { performance } from 'node:perf_hooks';
import type { ComponentRunResult, EngineMetrics } from '../types.js';
import { parseMarkdownBlocks } from './markdown-blocks.js';
import { extractOutlineToc } from './outline-toc.js';
import { wordCount } from './word-count.js';

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(sorted.length * pct);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function executeLegacyComponent(componentId: string, markdown: string): unknown {
  switch (componentId) {
    case 'word-count':
    case 'doc-stats':
      return wordCount(markdown);
    case 'outline-toc':
      return extractOutlineToc(markdown);
    case 'markdown-blocks':
      return parseMarkdownBlocks(markdown);
    default:
      throw new Error(
        `Unknown legacy component "${componentId}". Supported: word-count, outline-toc, markdown-blocks`,
      );
  }
}

/**
 * Benchmarks a legacy TS component for `iterations` runs and records
 * p50/p95/mean latency plus current Node.js process RSS in KB.
 */
export function runLegacyBenchmark<T = unknown>(
  componentId: string,
  markdown: string,
  iterations = 100,
): ComponentRunResult<T> {
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`iterations must be a positive integer, got ${iterations}`);
  }

  const samples: number[] = new Array<number>(iterations);
  let lastOutput: unknown;
  let peakRssBytes = process.memoryUsage().rss;

  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    lastOutput = executeLegacyComponent(componentId, markdown);
    samples[i] = performance.now() - t0;
  }

  const rssAfter = process.memoryUsage().rss;
  if (rssAfter > peakRssBytes) {
    peakRssBytes = rssAfter;
  }

  samples.sort((a, b) => a - b);
  const meanMs = samples.reduce((sum, val) => sum + val, 0) / samples.length;

  const metrics: EngineMetrics = {
    iterations,
    p50Ms: roundMs(percentile(samples, 0.5)),
    p95Ms: roundMs(percentile(samples, 0.95)),
    meanMs: roundMs(meanMs),
    peakRssKb: Math.round(peakRssBytes / 1024),
  };

  return {
    component: componentId,
    engine: 'legacy-ts',
    output: lastOutput as T,
    metrics,
  };
}
