import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveRepoRoot } from './paths.js';
import type { ComponentRunResult } from './types.js';

const execFileAsync = promisify(execFile);

export interface RustCliErrorPayload {
  component?: string;
  engine?: string;
  error: string;
  code: string;
}

export class RustBridgeError extends Error {
  readonly code: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, code: string, exitCode: number | null, stderr = '') {
    super(message);
    this.name = 'RustBridgeError';
    this.code = code;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export interface RustBinaryInfo {
  mode: 'release-binary' | 'debug-binary' | 'cargo-run';
  command: string;
  baseArgs: string[];
  binaryPath: string | null;
  binarySizeKb: number | null;
}

/**
 * Resolves the compiled `marktext-core-cli` binary (preferring release, then debug,
 * then falling back to `cargo run --quiet --manifest-path rust/Cargo.toml --bin marktext-core-cli --`).
 */
export function locateRustCli(repoRoot: string = resolveRepoRoot()): RustBinaryInfo {
  const exeSuffix = process.platform === 'win32' ? '.exe' : '';
  const releaseBin = path.join(repoRoot, 'rust', 'target', 'release', `marktext-core-cli${exeSuffix}`);
  if (fs.existsSync(releaseBin)) {
    const stat = fs.statSync(releaseBin);
    return {
      mode: 'release-binary',
      command: releaseBin,
      baseArgs: [],
      binaryPath: releaseBin,
      binarySizeKb: Math.round(stat.size / 1024),
    };
  }

  const debugBin = path.join(repoRoot, 'rust', 'target', 'debug', `marktext-core-cli${exeSuffix}`);
  if (fs.existsSync(debugBin)) {
    const stat = fs.statSync(debugBin);
    return {
      mode: 'debug-binary',
      command: debugBin,
      baseArgs: [],
      binaryPath: debugBin,
      binarySizeKb: Math.round(stat.size / 1024),
    };
  }

  const manifestPath = path.join(repoRoot, 'rust', 'Cargo.toml');
  return {
    mode: 'cargo-run',
    command: 'cargo',
    baseArgs: ['run', '--quiet', '--manifest-path', manifestPath, '--bin', 'marktext-core-cli', '--'],
    binaryPath: null,
    binarySizeKb: null,
  };
}

export interface RunRustCliOptions {
  iterations?: number;
  repoRoot?: string;
  timeoutMs?: number;
}

/**
 * Invokes `marktext-core-cli <subcommand> --input <file> --iterations <N>`
 * and parses the structured JSON envelope.
 */
export async function runRustCli<T = unknown>(
  subcommand: string,
  inputFilePath: string,
  options: RunRustCliOptions = {},
): Promise<ComponentRunResult<T>> {
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const iterations = options.iterations ?? 100;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const bin = locateRustCli(repoRoot);

  const args = [
    ...bin.baseArgs,
    subcommand,
    '--input',
    inputFilePath,
    '--iterations',
    String(iterations),
  ];

  try {
    const { stdout } = await execFileAsync(bin.command, args, {
      cwd: repoRoot,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as ComponentRunResult<T>;
    if (!parsed || typeof parsed !== 'object' || !('output' in parsed) || !('metrics' in parsed)) {
      throw new RustBridgeError(
        `Unexpected JSON output from marktext-core-cli for "${subcommand}"`,
        'INVALID_OUTPUT',
        0,
        stdout.slice(0, 500),
      );
    }
    return parsed;
  } catch (err) {
    if (err instanceof RustBridgeError) {
      throw err;
    }

    const execErr = err as NodeJS.ErrnoException & {
      code?: string | number;
      stderr?: string;
      stdout?: string;
    };
    const stderr = (execErr.stderr ?? '').trim();
    const exitCode = typeof execErr.code === 'number' ? execErr.code : null;

    // Parse structured JSON error envelope emitted on stderr by marktext-core-cli
    if (stderr.length > 0) {
      const lastLine = stderr.split('\n').pop()?.trim() ?? '';
      try {
        const parsedErr = JSON.parse(lastLine) as Partial<RustCliErrorPayload>;
        if (parsedErr.error && parsedErr.code) {
          throw new RustBridgeError(parsedErr.error, parsedErr.code, exitCode, stderr);
        }
      } catch (parseErr) {
        if (parseErr instanceof RustBridgeError) throw parseErr;
      }
    }

    const fallbackMsg = stderr || execErr.message || String(err);
    throw new RustBridgeError(
      `marktext-core-cli failed for "${subcommand}": ${fallbackMsg}`,
      'EXEC_FAILED',
      exitCode,
      stderr,
    );
  }
}
