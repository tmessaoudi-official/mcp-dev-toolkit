import { describe, expect, it } from 'vitest';
import { commandExists, run, runOrThrow } from '../../src/utils/shell.js';

describe('shell utils', () => {
  describe('run()', () => {
    it('returns stdout, stderr, and exit code for a successful command', async () => {
      const result = await run('echo', ['hello world']);
      expect(result.stdout.trim()).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
    });

    it('returns non-zero exit code without throwing', async () => {
      const result = await run('false', []);
      expect(result.code).toBe(1);
    });

    it('captures stderr separately from stdout', async () => {
      const result = await run('bash', ['-c', 'echo out; echo err >&2']);
      expect(result.stdout.trim()).toBe('out');
      expect(result.stderr.trim()).toBe('err');
    });

    it('respects cwd option', async () => {
      const result = await run('pwd', [], { cwd: '/tmp' });
      expect(result.stdout.trim()).toBe('/tmp');
      expect(result.code).toBe(0);
    });

    it('throws on timeout', async () => {
      await expect(run('sleep', ['10'], { timeoutMs: 100 })).rejects.toThrow('timed out');
    });

    it('throws if binary does not exist', async () => {
      await expect(run('__nonexistent_binary__', [])).rejects.toThrow();
    });
  });

  describe('runOrThrow()', () => {
    it('resolves on success', async () => {
      const result = await runOrThrow('echo', ['ok']);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
    });

    it('throws on non-zero exit', async () => {
      await expect(runOrThrow('bash', ['-c', 'exit 2'])).rejects.toThrow('exited with code 2');
    });
  });

  describe('commandExists()', () => {
    it('returns true for known binaries', async () => {
      expect(await commandExists('echo')).toBe(true);
      expect(await commandExists('git')).toBe(true);
    });

    it('returns false for non-existent binaries', async () => {
      expect(await commandExists('__no_such_binary_xyz__')).toBe(false);
    });
  });
});
