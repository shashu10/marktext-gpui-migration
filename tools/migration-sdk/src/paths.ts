import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import type { EvalRunRecord, MigrationSpec } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedRepoRoot: string | null = null;

/**
 * Walks upward from this module (or cwd) to locate the monorepo root
 * containing `migrations/` and `config/migration-flags/`.
 */
export function resolveRepoRoot(startDir: string = __dirname): string {
  if (startDir === __dirname && cachedRepoRoot) {
    return cachedRepoRoot;
  }

  let current = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    const migrationsDir = path.join(current, 'migrations');
    const flagsDir = path.join(current, 'config', 'migration-flags');
    if (fs.existsSync(migrationsDir) && fs.existsSync(flagsDir)) {
      if (startDir === __dirname) {
        cachedRepoRoot = current;
      }
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(
    `Could not locate repository root (expected migrations/ and config/migration-flags/) starting from ${startDir}`,
  );
}

export interface LoadedEnvConfig {
  repoRoot: string;
  apiKey: string | undefined;
  modelId: string;
  envFileLoaded: boolean;
}

/**
 * Loads `.env` from repository root (if present) without overriding already-set
 * process environment variables, and returns explicit SDK credentials/config.
 */
export function loadEnvConfig(repoRoot: string = resolveRepoRoot()): LoadedEnvConfig {
  const envPath = path.join(repoRoot, '.env');
  let envFileLoaded = false;
  if (fs.existsSync(envPath)) {
    const result = dotenv.config({ path: envPath, override: false });
    envFileLoaded = !result.error;
  }

  const rawKey = process.env.CURSOR_API_KEY?.trim();
  const apiKey = rawKey && rawKey.length > 0 ? rawKey : undefined;
  const modelId = process.env.CURSOR_MODEL_ID?.trim() || 'composer-2.5';

  return {
    repoRoot,
    apiKey,
    modelId,
    envFileLoaded,
  };
}

export function loadMigrationSpec(
  componentId: string,
  repoRoot: string = resolveRepoRoot(),
): MigrationSpec {
  const specPath = path.join(repoRoot, 'migrations', `${componentId}.json`);
  if (!fs.existsSync(specPath)) {
    const available = listMigrationSpecIds(repoRoot);
    throw new Error(
      `Migration spec not found for component "${componentId}" at ${specPath}. Available: ${available.join(', ') || '(none)'}`,
    );
  }
  const raw = fs.readFileSync(specPath, 'utf8');
  return JSON.parse(raw) as MigrationSpec;
}

export function listMigrationSpecIds(repoRoot: string = resolveRepoRoot()): string[] {
  const migrationsDir = path.join(repoRoot, 'migrations');
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

export function writeEvalRunRecord(
  record: EvalRunRecord,
  repoRoot: string = resolveRepoRoot(),
): string {
  const runsDir = path.join(repoRoot, 'evals', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  const safeTs = record.timestamp.replace(/[:.]/g, '-');
  const filename = `${safeTs}-${record.kind}-${record.componentId}.json`;
  const outPath = path.join(runsDir, filename);
  fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return outPath;
}
