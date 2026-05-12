import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    resolve: vi.fn((p: string) => p),
    dirname: actual.dirname,
  };
});

vi.mock('../../src/utils/shell.js', () => ({
  run: vi.fn(),
}));

import { gitBlameContext } from '../../src/tools/git-blame-context.js';
import { run } from '../../src/utils/shell.js';

const mockRun = vi.mocked(run);
const mockExistsSync = vi.mocked(existsSync);

// Sample git blame --porcelain output (hashes must be exactly 40 hex chars)
const HASH_A = 'abc123456789012345678901234567890123abcd';
const HASH_B = 'def123456789012345678901234567890123abcd';

const sampleBlame = `${HASH_A} 1 1 1
author Alice Smith
author-mail <alice@example.com>
author-time 1700000000
author-tz +0100
committer Bob
committer-mail <bob@example.com>
committer-time 1700000000
committer-tz +0100
summary Fix login bug
filename src/auth.ts
\tconst user = await getUser(id);
${HASH_B} 2 2 1
author Bob Jones
author-mail <bob@example.com>
author-time 1699000000
author-tz +0000
committer Bob
committer-mail <bob@example.com>
committer-time 1699000000
committer-tz +0000
summary Add auth module
filename src/auth.ts
\treturn null;
`;

const sampleLogOutput = `${HASH_A}
abc12345
Alice Smith
alice@example.com
2023-11-14T20:00:00+01:00
Fix login bug
Closes #42`;

describe('gitBlameContext()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await gitBlameContext({
      file_path: '/nonexistent/file.ts',
      start_line: 1,
      end_line: 5,
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('File not found');
  });

  it('returns error when start_line > end_line', async () => {
    mockExistsSync.mockReturnValue(true);

    const result = await gitBlameContext({ file_path: '/file.ts', start_line: 10, end_line: 5 });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('start_line');
  });

  it('returns error when file is not in a git repo', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: 'not a git repo', code: 128 });

    const result = await gitBlameContext({ file_path: '/file.ts', start_line: 1, end_line: 2 });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Not a git repository');
  });

  it('returns parsed blame lines with commit details', async () => {
    mockExistsSync.mockReturnValue(true);

    // git rev-parse --show-toplevel
    mockRun.mockResolvedValueOnce({ stdout: '/repo\n', stderr: '', code: 0 });
    // git blame --porcelain
    mockRun.mockResolvedValueOnce({ stdout: sampleBlame, stderr: '', code: 0 });
    // git log for first commit hash
    mockRun.mockResolvedValueOnce({ stdout: sampleLogOutput, stderr: '', code: 0 });
    // git log for second commit hash
    mockRun.mockResolvedValueOnce({
      stdout: `${HASH_B}\ndef98765\nBob Jones\nbob@example.com\n2023-11-03T10:00:00+00:00\nAdd auth module\n`,
      stderr: '',
      code: 0,
    });

    const result = await gitBlameContext({
      file_path: '/repo/src/auth.ts',
      start_line: 1,
      end_line: 2,
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      lines: { lineNumber: number; content: string; commit: { author: string } }[];
      uniqueCommits: { hash: string }[];
    };
    expect(success.success).toBe(true);
    expect(success.lines).toHaveLength(2);
    expect(success.lines[0]?.content).toContain('getUser');
    expect(success.uniqueCommits.length).toBeGreaterThanOrEqual(1);
  });

  it('returns error when git blame fails', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: bad revision', code: 128 });

    const result = await gitBlameContext({
      file_path: '/repo/file.ts',
      start_line: 1,
      end_line: 1,
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('git blame failed');
  });

  it('handles porcelain blame with malformed meta lines (no space)', async () => {
    mockExistsSync.mockReturnValue(true);

    // A blame entry where a meta line has no space (edge case — no key-value pair)
    const malformedMetaBlame = `${HASH_A} 1 1 1
author Alice
NOSPACEMETA
author-time 1700000000
author-tz +0100
summary Edge case
filename src/file.ts
\tconst x = 1;
`;

    mockRun
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: malformedMetaBlame, stderr: '', code: 0 })
      .mockResolvedValueOnce({
        stdout: `${HASH_A}\nabc12345\nAlice\nalice@example.com\n2023-01-01T00:00:00+00:00\nEdge case\n`,
        stderr: '',
        code: 0,
      });

    const result = await gitBlameContext({
      file_path: '/repo/src/file.ts',
      start_line: 1,
      end_line: 1,
    });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; lines: { content: string }[] };
    expect(success.lines).toHaveLength(1);
    expect(success.lines[0]?.content).toBe('const x = 1;');
  });

  it('handles porcelain blame output with non-hash top-level line', async () => {
    mockExistsSync.mockReturnValue(true);

    // Blame output with a non-hash non-empty line at the top level (triggers !headerMatch skip)
    const blameWithPreamble = `warning: some git warning here
${HASH_A} 1 1 1
author Alice
author-mail <alice@example.com>
author-time 1700000000
author-tz +0100
committer Alice
committer-mail <alice@example.com>
committer-time 1700000000
committer-tz +0100
summary Fix bug
filename src/file.ts
\tconst result = 42;
`;

    mockRun
      .mockResolvedValueOnce({ stdout: '/repo\n', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: blameWithPreamble, stderr: '', code: 0 })
      .mockResolvedValueOnce({
        stdout: `${HASH_A}\nabc12345\nAlice\nalice@example.com\n2023-01-01T00:00:00+00:00\nFix bug\n`,
        stderr: '',
        code: 0,
      });

    const result = await gitBlameContext({
      file_path: '/repo/src/file.ts',
      start_line: 1,
      end_line: 1,
    });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; lines: { content: string }[] };
    expect(success.lines).toHaveLength(1);
    expect(success.lines[0]?.content).toBe('const result = 42;');
  });
});
