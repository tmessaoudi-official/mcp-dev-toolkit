/**
 * docker_compose_status — Reports Docker Compose service status, port bindings,
 * last N log lines per container, and health check results.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { run } from '../utils/shell.js';

export const DockerComposeStatusInput = z.object({
  compose_file: z
    .string()
    .min(1)
    .describe('Absolute path to the docker-compose.yml (or docker-compose.yaml) file'),
  service: z.string().optional().describe('Optionally restrict to a single service name'),
});

export type DockerComposeStatusInput = z.infer<typeof DockerComposeStatusInput>;

export interface PortBinding {
  hostIp: string;
  hostPort: string;
  containerPort: string;
  protocol: string;
}

export interface HealthCheck {
  status: 'healthy' | 'unhealthy' | 'starting' | 'none';
  failingStreak: number;
  lastOutput: string;
}

export interface ServiceStatus {
  name: string;
  containerId: string | null;
  image: string;
  status: 'running' | 'stopped' | 'unhealthy' | 'starting' | 'exited' | 'unknown';
  state: string;
  ports: PortBinding[];
  health: HealthCheck;
  logTail: string[];
}

export interface DockerComposeStatusResult {
  success: true;
  composeFile: string;
  projectName: string;
  services: ServiceStatus[];
  checkedAt: string;
}

export interface DockerComposeStatusError {
  error: string;
  details?: Record<string, unknown>;
}

const LOG_LINES = 20;

export async function dockerComposeStatus(
  input: DockerComposeStatusInput,
): Promise<DockerComposeStatusResult | DockerComposeStatusError> {
  const composeFile = resolve(input.compose_file);

  if (!existsSync(composeFile)) {
    return { error: `Compose file not found: ${composeFile}` };
  }

  const cwd = dirname(composeFile);

  // Check docker and docker compose are available
  const dockerCheck = await run('docker', ['info', '--format', '{{.ServerVersion}}'], {
    cwd,
    timeoutMs: 10_000,
  });
  if (dockerCheck.code !== 0) {
    return {
      error: 'Docker daemon is not running or not accessible',
      details: { stderr: dockerCheck.stderr },
    };
  }

  // Derive project name from compose file directory
  const projectName = cwd.split('/').filter(Boolean).pop() ?? 'compose-project';

  // Get service list from compose file
  const baseArgs = ['compose', '-f', composeFile];
  const psArgs = [...baseArgs, 'ps', '--format=json'];
  if (input.service) psArgs.push(input.service);

  const psResult = await run('docker', psArgs, { cwd, timeoutMs: 30_000 });

  if (psResult.code !== 0) {
    return {
      error: `docker compose ps failed (exit ${psResult.code})`,
      details: { stderr: psResult.stderr.slice(0, 1000) },
    };
  }

  // Parse ps output — Docker outputs one JSON object per line (NDJSON)
  const psLines = psResult.stdout
    .trim()
    .split('\n')
    .filter((l) => l.trim().startsWith('{'));
  const psEntries = psLines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });

  if (psEntries.length === 0) {
    // Try legacy table format as fallback
    return {
      success: true,
      composeFile,
      projectName,
      services: [],
      checkedAt: new Date().toISOString(),
    };
  }

  const services: ServiceStatus[] = await Promise.all(
    psEntries.map((entry) => buildServiceStatus(entry, composeFile, cwd, baseArgs)),
  );

  return {
    success: true,
    composeFile,
    projectName,
    services,
    checkedAt: new Date().toISOString(),
  };
}

interface DockerPsEntry {
  Service?: string;
  Name?: string;
  ID?: string;
  Image?: string;
  State?: string;
  Status?: string;
  Publishers?: unknown;
  Ports?: unknown;
}

async function buildServiceStatus(
  entryRaw: Record<string, unknown>,
  _composeFile: string,
  cwd: string,
  baseArgs: string[],
): Promise<ServiceStatus> {
  const entry = entryRaw as DockerPsEntry;
  const name = String(entry.Service ?? entry.Name ?? 'unknown');
  const containerId = entry.ID != null ? String(entry.ID) : null;
  const image = String(entry.Image ?? '');
  const stateRaw = String(entry.State ?? entry.Status ?? '').toLowerCase();
  const status = normalizeStatus(stateRaw);
  const state = String(entry.Status ?? stateRaw);

  // Parse port bindings
  const ports = parsePorts(entry.Publishers ?? entry.Ports);

  // Health check from inspect
  const health = await getHealthStatus(containerId);

  // Log tail
  const logTail = await getLogTail(baseArgs, name, cwd);

  return { name, containerId, image, status, state, ports, health, logTail };
}

function normalizeStatus(raw: string): ServiceStatus['status'] {
  if (raw.includes('running')) return 'running';
  if (raw.includes('unhealthy')) return 'unhealthy';
  if (raw.includes('starting') || raw.includes('health: starting')) return 'starting';
  if (raw.includes('exited') || raw.includes('exit')) return 'exited';
  if (raw.includes('stopped') || raw === '') return 'stopped';
  return 'unknown';
}

function parsePorts(raw: unknown): PortBinding[] {
  if (!raw) return [];

  // Docker compose ps --format=json publishes as array of objects
  if (Array.isArray(raw)) {
    interface DockerPort {
      PublishedPort?: unknown;
      HostPort?: unknown;
      TargetPort?: unknown;
      ContainerPort?: unknown;
      URL?: unknown;
      HostIP?: unknown;
      Protocol?: unknown;
    }
    return raw.flatMap((p) => {
      const port = p as DockerPort;
      const publishedPort = port.PublishedPort ?? port.HostPort;
      const targetPort = port.TargetPort ?? port.ContainerPort;
      if (!publishedPort && !targetPort) return [];
      return [
        {
          hostIp: String(port.URL ?? port.HostIP ?? '0.0.0.0').split(':')[0] ?? '0.0.0.0',
          hostPort: String(publishedPort ?? ''),
          containerPort: String(targetPort ?? ''),
          protocol: String(port.Protocol ?? 'tcp'),
        },
      ];
    });
  }

  // String format: "0.0.0.0:8080->80/tcp, :::8080->80/tcp"
  if (typeof raw === 'string') {
    return raw.split(',').flatMap((part) => {
      const match = part.trim().match(/^([\d.]+):(\d+)->(\d+)\/(tcp|udp)/);
      if (!match) return [];
      return [
        {
          hostIp: match[1] ?? '0.0.0.0',
          hostPort: match[2] ?? '',
          containerPort: match[3] ?? '',
          protocol: match[4] ?? 'tcp',
        },
      ];
    });
  }

  return [];
}

async function getHealthStatus(containerId: string | null): Promise<HealthCheck> {
  if (!containerId) {
    return { status: 'none', failingStreak: 0, lastOutput: '' };
  }

  const result = await run(
    'docker',
    ['inspect', '--format', '{{json .State.Health}}', containerId],
    { timeoutMs: 10_000 },
  );

  if (result.code !== 0 || result.stdout.trim() === 'null' || !result.stdout.trim()) {
    return { status: 'none', failingStreak: 0, lastOutput: '' };
  }

  interface DockerHealth {
    Status?: string;
    FailingStreak?: number;
    Log?: Array<{ Output?: string }>;
  }

  try {
    const health = JSON.parse(result.stdout.trim()) as DockerHealth;
    const statusRaw = String(health.Status ?? 'none').toLowerCase();
    const status = (
      ['healthy', 'unhealthy', 'starting'].includes(statusRaw) ? statusRaw : 'none'
    ) as HealthCheck['status'];

    const log = Array.isArray(health.Log) ? health.Log : [];
    const lastEntry = log[log.length - 1];
    const lastOutput = lastEntry ? String(lastEntry.Output ?? '').slice(0, 500) : '';

    return {
      status,
      failingStreak: typeof health.FailingStreak === 'number' ? health.FailingStreak : 0,
      lastOutput,
    };
  } catch {
    return { status: 'none', failingStreak: 0, lastOutput: '' };
  }
}

async function getLogTail(baseArgs: string[], service: string, cwd: string): Promise<string[]> {
  const result = await run(
    'docker',
    [...baseArgs, 'logs', '--tail', String(LOG_LINES), '--timestamps', service],
    { cwd, timeoutMs: 15_000 },
  );

  // Docker logs go to stderr by default
  const combined = (result.stdout + result.stderr).trim();
  if (!combined) return [];
  return combined.split('\n').slice(-LOG_LINES);
}
