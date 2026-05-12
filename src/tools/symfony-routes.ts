/**
 * symfony_routes — Lists Symfony routes by running bin/console debug:router --format=json.
 * Falls back gracefully if not a Symfony project.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { run } from '../utils/shell.js';

export const SymfonyRoutesInput = z.object({
  project_path: z.string().min(1).describe('Absolute path to the Symfony project root'),
  filter: z
    .string()
    .optional()
    .describe('Filter routes by name or path (case-insensitive substring match)'),
});

export type SymfonyRoutesInput = z.infer<typeof SymfonyRoutesInput>;

export interface RouteInfo {
  name: string;
  path: string;
  methods: string[];
  controller: string;
  defaults: Record<string, unknown>;
  requirements: Record<string, string>;
  schemes: string[];
  host: string;
}

export interface SymfonyRoutesResult {
  success: true;
  projectPath: string;
  phpVersion: string | null;
  totalRoutes: number;
  routes: RouteInfo[];
}

export interface SymfonyRoutesError {
  error: string;
  details?: Record<string, unknown>;
}

export async function symfonyRoutes(
  input: SymfonyRoutesInput,
): Promise<SymfonyRoutesResult | SymfonyRoutesError> {
  const consolePath = join(input.project_path, 'bin', 'console');

  if (!existsSync(consolePath)) {
    return {
      error: `Not a Symfony project: 'bin/console' not found at ${input.project_path}`,
      details: { checked: consolePath },
    };
  }

  // Detect PHP binary
  const phpBin = await detectPhpBinary(input.project_path);

  const result = await run(
    phpBin,
    [consolePath, 'debug:router', '--format=json', '--no-interaction'],
    {
      cwd: input.project_path,
      timeoutMs: 30_000,
    },
  );

  if (result.code !== 0) {
    return {
      error: `bin/console debug:router failed (exit ${result.code})`,
      details: { stderr: result.stderr.slice(0, 2000), stdout: result.stdout.slice(0, 500) },
    };
  }

  let rawRoutes: Record<string, unknown>;
  try {
    rawRoutes = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      error: 'Failed to parse JSON output from debug:router',
      details: { raw: result.stdout.slice(0, 500) },
    };
  }

  const routes = parseRoutes(rawRoutes);
  const filterLower = input.filter?.toLowerCase();
  const filtered = filterLower
    ? routes.filter(
        (r) =>
          r.name.toLowerCase().includes(filterLower) || r.path.toLowerCase().includes(filterLower),
      )
    : routes;

  const phpVersion = await getPhpVersion(phpBin);

  return {
    success: true,
    projectPath: input.project_path,
    phpVersion,
    totalRoutes: filtered.length,
    routes: filtered,
  };
}

interface SymfonyRouteData {
  path?: unknown;
  methods?: unknown;
  controller?: unknown;
  defaults?: Record<string, unknown>;
  requirements?: Record<string, string>;
  schemes?: unknown[];
  host?: unknown;
}

interface SymfonyRouteDefaults {
  _controller?: unknown;
  [key: string]: unknown;
}

function parseRouteController(r: SymfonyRouteData): string {
  const defaults = (r.defaults ?? {}) as SymfonyRouteDefaults;
  if (typeof defaults._controller === 'string') return defaults._controller;
  if (typeof r.controller === 'string') return r.controller;
  return 'unknown';
}

function parseRouteMethods(r: SymfonyRouteData): string[] {
  if (Array.isArray(r.methods) && r.methods.length > 0) return r.methods.map(String);
  if (typeof r.methods === 'string' && r.methods.length > 0) return [r.methods];
  return ['ANY'];
}

function parseRoutes(raw: Record<string, unknown>): RouteInfo[] {
  // Symfony debug:router --format=json returns an object keyed by route name
  return Object.entries(raw).map(([name, data]) => {
    const r = (data ?? {}) as SymfonyRouteData;

    return {
      name,
      path: typeof r.path === 'string' ? r.path : String(r.path ?? ''),
      methods: parseRouteMethods(r),
      controller: parseRouteController(r),
      defaults: r.defaults ?? {},
      requirements: r.requirements ?? {},
      schemes: Array.isArray(r.schemes) ? r.schemes.map(String) : [],
      host: typeof r.host === 'string' ? r.host : '',
    };
  });
}

async function detectPhpBinary(projectPath: string): Promise<string> {
  // Try project-local PHP via Composer's vendor/bin or system php
  const candidates = ['php', 'php8.4', 'php8.3', 'php8.2', 'php8.1', 'php8.0'];
  for (const bin of candidates) {
    const result = await run(bin, ['--version'], { cwd: projectPath, timeoutMs: 5_000 });
    if (result.code === 0) return bin;
  }
  return 'php';
}

async function getPhpVersion(phpBin: string): Promise<string | null> {
  const result = await run(phpBin, ['--version'], { timeoutMs: 5_000 });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/PHP (\d+\.\d+\.\d+)/);
  return match?.[1] ?? null;
}
