/**
 * git_blame_context — Returns git blame + commit details for a line range.
 * Uses porcelain format for reliable machine parsing.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { run } from '../utils/shell.js';

export const GitBlameContextInput = z.object({
  file_path: z.string().min(1).describe('Absolute path to the file to blame'),
  start_line: z.number().int().min(1).describe('First line number (1-indexed, inclusive)'),
  end_line: z.number().int().min(1).describe('Last line number (1-indexed, inclusive)'),
});

export type GitBlameContextInput = z.infer<typeof GitBlameContextInput>;

export interface CommitDetail {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  summary: string;
  body: string;
}

export interface LineBlame {
  lineNumber: number;
  content: string;
  commit: CommitDetail;
}

export interface GitBlameContextResult {
  success: true;
  filePath: string;
  startLine: number;
  endLine: number;
  repoRoot: string;
  lines: LineBlame[];
  uniqueCommits: CommitDetail[];
}

export interface GitBlameContextError {
  error: string;
  details?: Record<string, unknown>;
}

export async function gitBlameContext(
  input: GitBlameContextInput,
): Promise<GitBlameContextResult | GitBlameContextError> {
  const filePath = resolve(input.file_path);

  if (!existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  if (input.start_line > input.end_line) {
    return { error: `start_line (${input.start_line}) must be <= end_line (${input.end_line})` };
  }

  const cwd = dirname(filePath);

  // Find git root
  const rootResult = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (rootResult.code !== 0) {
    return { error: `Not a git repository: ${filePath}`, details: { stderr: rootResult.stderr } };
  }
  const repoRoot = rootResult.stdout.trim();

  // Run git blame with porcelain format for the line range
  const blameResult = await run(
    'git',
    ['blame', '--porcelain', `-L${input.start_line},${input.end_line}`, filePath],
    { cwd: repoRoot, timeoutMs: 30_000 },
  );

  if (blameResult.code !== 0) {
    return {
      error: `git blame failed (exit ${blameResult.code})`,
      details: { stderr: blameResult.stderr.slice(0, 1000) },
    };
  }

  const blameData = parsePorcelainBlame(blameResult.stdout, input.start_line);

  // Collect unique commit hashes and fetch full details
  const uniqueHashes = [...new Set(blameData.map((b) => b.hash))];
  const commitDetails = await fetchCommitDetails(repoRoot, uniqueHashes);

  const lines: LineBlame[] = blameData.map((b) => ({
    lineNumber: b.lineNumber,
    content: b.content,
    commit: commitDetails.get(b.hash) ?? {
      hash: b.hash,
      shortHash: b.hash.slice(0, 8),
      author: b.author,
      email: b.email,
      date: b.date,
      summary: b.summary,
      body: '',
    },
  }));

  const uniqueCommits = [...commitDetails.values()];

  return {
    success: true,
    filePath,
    startLine: input.start_line,
    endLine: input.end_line,
    repoRoot,
    lines,
    uniqueCommits,
  };
}

interface BlameEntry {
  hash: string;
  lineNumber: number;
  content: string;
  author: string;
  email: string;
  date: string;
  summary: string;
}

interface ParseState {
  lines: string[];
  i: number;
}

function parseMeta(state: ParseState): Record<string, string> {
  const meta: Record<string, string> = {};
  while (state.i < state.lines.length && !state.lines[state.i]?.startsWith('\t')) {
    const metaLine = state.lines[state.i] ?? '';
    const spaceIdx = metaLine.indexOf(' ');
    if (spaceIdx > 0) {
      meta[metaLine.slice(0, spaceIdx)] = metaLine.slice(spaceIdx + 1);
    }
    state.i++;
  }
  return meta;
}

function metaToEntry(
  hash: string,
  finalLine: number,
  content: string,
  meta: Record<string, string>,
  currentLineNum: number,
): BlameEntry {
  return {
    hash,
    lineNumber: finalLine || currentLineNum,
    content,
    author: meta.author ?? 'unknown',
    email: meta['author-mail']?.replace(/[<>]/g, '') ?? '',
    date: meta['author-time']
      ? new Date(parseInt(meta['author-time'], 10) * 1000).toISOString()
      : '',
    summary: meta.summary ?? '',
  };
}

function parsePorcelainBlame(output: string, startLine: number): BlameEntry[] {
  const entries: BlameEntry[] = [];
  const state: ParseState = { lines: output.split('\n'), i: 0 };
  let currentLineNum = startLine;

  while (state.i < state.lines.length) {
    const line = state.lines[state.i];
    if (!line) {
      state.i++;
      continue;
    }

    // Header line: <hash> <orig-line> <final-line> [<count>]
    const headerMatch = line.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (!headerMatch) {
      state.i++;
      continue;
    }

    const hash = headerMatch[1] ?? '';
    const finalLine = parseInt(headerMatch[2] ?? '0', 10);
    state.i++;

    const meta = parseMeta(state);
    const content = state.lines[state.i]?.startsWith('\t')
      ? (state.lines[state.i]?.slice(1) ?? '')
      : '';
    state.i++;

    entries.push(metaToEntry(hash, finalLine, content, meta, currentLineNum));
    currentLineNum++;
  }

  return entries;
}

async function fetchCommitDetails(
  repoRoot: string,
  hashes: string[],
): Promise<Map<string, CommitDetail>> {
  const map = new Map<string, CommitDetail>();

  await Promise.all(
    hashes.map(async (hash) => {
      const result = await run(
        'git',
        ['log', '-1', '--format=%H%n%h%n%an%n%ae%n%aI%n%s%n%b', hash],
        { cwd: repoRoot, timeoutMs: 10_000 },
      );

      if (result.code !== 0) return;

      const parts = result.stdout.split('\n');
      map.set(hash, {
        hash: parts[0]?.trim() ?? hash,
        shortHash: parts[1]?.trim() ?? hash.slice(0, 8),
        author: parts[2]?.trim() ?? 'unknown',
        email: parts[3]?.trim() ?? '',
        date: parts[4]?.trim() ?? '',
        summary: parts[5]?.trim() ?? '',
        body: parts.slice(6).join('\n').trim(),
      });
    }),
  );

  return map;
}
