/**
 * symfony_services — Lists Symfony DI services via bin/console debug:container --format=json.
 * Returns: id, class, tags, aliases, public/private, scope.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { run } from '../utils/shell.js';

export const SymfonyServicesInput = z.object({
  project_path: z.string().min(1).describe('Absolute path to the Symfony project root'),
  filter: z
    .string()
    .optional()
    .describe('Filter services by id or class (case-insensitive substring match)'),
});

export type SymfonyServicesInput = z.infer<typeof SymfonyServicesInput>;

export interface ServiceTag {
  name: string;
  attributes: Record<string, unknown>;
}

export interface ServiceInfo {
  id: string;
  class: string | null;
  public: boolean;
  abstract: boolean;
  synthetic: boolean;
  lazy: boolean;
  shared: boolean;
  tags: ServiceTag[];
  aliases: string[];
  decorates: string | null;
}

export interface SymfonyServicesResult {
  success: true;
  projectPath: string;
  phpVersion: string | null;
  totalServices: number;
  services: ServiceInfo[];
}

export interface SymfonyServicesError {
  error: string;
  details?: Record<string, unknown>;
}

export async function symfonyServices(
  input: SymfonyServicesInput,
): Promise<SymfonyServicesResult | SymfonyServicesError> {
  const consolePath = join(input.project_path, 'bin', 'console');

  if (!existsSync(consolePath)) {
    return {
      error: `Not a Symfony project: 'bin/console' not found at ${input.project_path}`,
      details: { checked: consolePath },
    };
  }

  const phpBin = await detectPhpBinary(input.project_path);

  // Try debug:container first, fall back to debug:autowiring
  const result = await run(
    phpBin,
    [consolePath, 'debug:container', '--format=json', '--no-interaction', '--show-private'],
    { cwd: input.project_path, timeoutMs: 45_000 },
  );

  if (result.code !== 0) {
    return {
      error: `bin/console debug:container failed (exit ${result.code})`,
      details: { stderr: result.stderr.slice(0, 2000) },
    };
  }

  let rawServices: unknown;
  try {
    rawServices = JSON.parse(result.stdout);
  } catch {
    return {
      error: 'Failed to parse JSON output from debug:container',
      details: { raw: result.stdout.slice(0, 500) },
    };
  }

  const services = parseServices(rawServices);
  const filterLower = input.filter?.toLowerCase();
  const filtered = filterLower
    ? services.filter(
        (s) =>
          s.id.toLowerCase().includes(filterLower) ||
          (s.class ?? '').toLowerCase().includes(filterLower),
      )
    : services;

  const phpVersion = await getPhpVersion(phpBin);

  return {
    success: true,
    projectPath: input.project_path,
    phpVersion,
    totalServices: filtered.length,
    services: filtered,
  };
}

function parseServices(raw: unknown): ServiceInfo[] {
  // Symfony outputs an array of service descriptor objects
  if (Array.isArray(raw)) {
    return raw.map(parseOneService);
  }

  // Fallback: may be an object keyed by service id
  if (raw !== null && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([id, data]) => {
      const svc = parseOneService(data);
      if (!svc.id) svc.id = id;
      return svc;
    });
  }

  return [];
}

interface RawService {
  id?: unknown;
  service_id?: unknown;
  class?: unknown;
  public?: unknown;
  abstract?: unknown;
  synthetic?: unknown;
  lazy?: unknown;
  shared?: unknown;
  tags?: unknown;
  aliases?: unknown;
  decorates?: unknown;
}

function parseTags(rawTags: unknown): ServiceTag[] {
  const tags: ServiceTag[] = [];
  if (Array.isArray(rawTags)) {
    for (const t of rawTags) {
      const tag = t as Record<string, unknown>;
      tags.push({
        name: String(tag.name ?? ''),
        attributes: Object.fromEntries(Object.entries(tag).filter(([k]) => k !== 'name')),
      });
    }
  } else if (rawTags !== null && typeof rawTags === 'object') {
    for (const [tagName, attrs] of Object.entries(rawTags as Record<string, unknown>)) {
      tags.push({ name: tagName, attributes: (attrs ?? {}) as Record<string, unknown> });
    }
  }
  return tags;
}

function parseOneService(raw: unknown): ServiceInfo {
  const r = (raw ?? {}) as RawService;
  const aliases = Array.isArray(r.aliases)
    ? r.aliases.map(String)
    : typeof r.aliases === 'string'
      ? [r.aliases]
      : [];

  return {
    id: String(r.id ?? r.service_id ?? ''),
    class: r.class != null ? String(r.class) : null,
    public: Boolean(r.public ?? false),
    abstract: Boolean(r.abstract ?? false),
    synthetic: Boolean(r.synthetic ?? false),
    lazy: Boolean(r.lazy ?? false),
    shared: r.shared !== undefined ? Boolean(r.shared) : true,
    tags: parseTags(r.tags),
    aliases,
    decorates: r.decorates != null ? String(r.decorates) : null,
  };
}

async function detectPhpBinary(projectPath: string): Promise<string> {
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
