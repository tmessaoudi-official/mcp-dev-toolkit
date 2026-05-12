/**
 * Safe shell execution utilities.
 * Always uses spawn with array args — never string interpolation.
 * This prevents shell injection attacks when handling user-supplied inputs.
 */

import { spawn } from 'node:child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface ShellOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/**
 * Execute a command with explicit args array (no shell injection risk).
 *
 * @param cmd - The command to execute (e.g. "git")
 * @param args - Arguments as a string array (e.g. ["blame", "-L", "1,10", "file.ts"])
 * @param options - Optional cwd, env, timeout
 */
export async function run(
  cmd: string,
  args: string[],
  options: ShellOptions = {},
): Promise<ShellResult> {
  const { cwd, env, timeoutMs = 30_000 } = options;

  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false, // NEVER use shell: true — prevents injection
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 3_000);
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn '${cmd}': ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `Command '${cmd} ${args.slice(0, 3).join(' ')}' timed out after ${timeoutMs}ms`,
          ),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
        code: code ?? 1,
      });
    });
  });
}

/**
 * Like run(), but throws if exit code is non-zero.
 */
export async function runOrThrow(
  cmd: string,
  args: string[],
  options: ShellOptions = {},
): Promise<ShellResult> {
  const result = await run(cmd, args, options);
  if (result.code !== 0) {
    throw new Error(
      `Command '${cmd} ${args.slice(0, 5).join(' ')}' exited with code ${result.code}:\n${result.stderr.slice(0, 1000)}`,
    );
  }
  return result;
}

/**
 * Checks whether a binary exists in PATH.
 */
export async function commandExists(cmd: string): Promise<boolean> {
  const result = await run('which', [cmd]);
  return result.code === 0;
}
