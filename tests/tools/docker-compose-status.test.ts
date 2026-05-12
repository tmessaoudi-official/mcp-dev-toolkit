import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return {
    ...actual,
    resolve: vi.fn((p: string) => p),
    dirname: vi.fn((p: string) => actual.dirname(p)),
  };
});

vi.mock('../../src/utils/shell.js', () => ({
  run: vi.fn(),
}));

import { dockerComposeStatus } from '../../src/tools/docker-compose-status.js';
import { run } from '../../src/utils/shell.js';

const mockRun = vi.mocked(run);
const mockExistsSync = vi.mocked(existsSync);

const samplePsEntry = JSON.stringify({
  ID: 'abc123def456',
  Service: 'web',
  Image: 'nginx:alpine',
  State: 'running',
  Status: 'Up 2 hours',
  Publishers: [{ URL: '0.0.0.0', PublishedPort: '8080', TargetPort: '80', Protocol: 'tcp' }],
});

describe('dockerComposeStatus()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when compose file not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await dockerComposeStatus({ compose_file: '/nonexistent/docker-compose.yml' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns error when docker daemon is not running', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRun.mockResolvedValueOnce({
      stdout: '',
      stderr: 'Cannot connect to Docker daemon',
      code: 1,
    });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Docker daemon');
  });

  it('returns empty services array when no containers are running', async () => {
    mockExistsSync.mockReturnValue(true);

    // docker info
    mockRun.mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 });
    // docker compose ps
    mockRun.mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; services: unknown[] };
    expect(success.success).toBe(true);
    expect(success.services).toHaveLength(0);
  });

  it('returns service status with ports and logs', async () => {
    mockExistsSync.mockReturnValue(true);

    // docker info
    mockRun.mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 });
    // docker compose ps (returns NDJSON)
    mockRun.mockResolvedValueOnce({ stdout: `${samplePsEntry}\n`, stderr: '', code: 0 });
    // docker inspect (health)
    mockRun.mockResolvedValueOnce({
      stdout: JSON.stringify({ Status: 'healthy', FailingStreak: 0, Log: [] }),
      stderr: '',
      code: 0,
    });
    // docker compose logs
    mockRun.mockResolvedValueOnce({
      stdout: '',
      stderr: '2024-01-01T00:00:00Z web started\n',
      code: 0,
    });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      services: {
        name: string;
        status: string;
        ports: { hostPort: string }[];
        health: { status: string };
      }[];
    };
    expect(success.services).toHaveLength(1);
    expect(success.services[0]?.name).toBe('web');
    expect(success.services[0]?.status).toBe('running');
    expect(success.services[0]?.ports[0]?.hostPort).toBe('8080');
    expect(success.services[0]?.health.status).toBe('healthy');
  });

  it('normalizes different status strings correctly', async () => {
    mockExistsSync.mockReturnValue(true);

    const exitedEntry = JSON.stringify({
      ID: 'xyz789',
      Service: 'db',
      Image: 'postgres:16',
      State: 'exited',
      Status: 'Exited (1) 5 minutes ago',
      Publishers: [],
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: exitedEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 }) // inspect — no health
      .mockResolvedValueOnce({ stdout: '', stderr: 'Container stopped', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as { success: true; services: { status: string }[] };
    expect(success.services[0]?.status).toBe('exited');
  });

  it('returns error when docker compose ps fails', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 }) // docker info
      .mockResolvedValueOnce({ stdout: '', stderr: 'compose error', code: 1 }); // compose ps fails

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('docker compose ps failed');
  });

  it('parses string-format port bindings', async () => {
    mockExistsSync.mockReturnValue(true);

    const stringPortEntry = JSON.stringify({
      ID: 'abc123',
      Service: 'api',
      Image: 'myapp:latest',
      State: 'running',
      Status: 'Up 1 hour',
      Ports: '0.0.0.0:3000->3000/tcp',
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: stringPortEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 }) // inspect
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // logs

    const result = await dockerComposeStatus({
      compose_file: '/app/docker-compose.yml',
      service: 'api',
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      services: { ports: { hostPort: string; containerPort: string; protocol: string }[] }[];
    };
    expect(success.services[0]?.ports[0]?.hostPort).toBe('3000');
    expect(success.services[0]?.ports[0]?.containerPort).toBe('3000');
    expect(success.services[0]?.ports[0]?.protocol).toBe('tcp');
  });

  it('handles service with unhealthy health check and failing log', async () => {
    mockExistsSync.mockReturnValue(true);

    const unhealthyEntry = JSON.stringify({
      ID: 'def456',
      Service: 'cache',
      Image: 'redis:7',
      State: 'running',
      Status: 'Up (unhealthy)',
      Publishers: [],
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: unhealthyEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          Status: 'unhealthy',
          FailingStreak: 3,
          Log: [{ Output: 'connection refused\n' }],
        }),
        stderr: '',
        code: 0,
      })
      .mockResolvedValueOnce({ stdout: '', stderr: 'log line 1\nlog line 2\n', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      services: {
        status: string;
        health: { status: string; failingStreak: number; lastOutput: string };
      }[];
    };
    // State is 'running' — health check result is separate from service state
    expect(success.services[0]?.status).toBe('running');
    expect(success.services[0]?.health.status).toBe('unhealthy');
    expect(success.services[0]?.health.failingStreak).toBe(3);
    expect(success.services[0]?.health.lastOutput).toContain('connection refused');
  });

  it('handles port publisher entries with no published port', async () => {
    mockExistsSync.mockReturnValue(true);

    const internalPortEntry = JSON.stringify({
      ID: 'aaa111',
      Service: 'worker',
      Image: 'worker:latest',
      State: 'running',
      Status: 'Up 30 seconds',
      Publishers: [
        { Protocol: 'tcp' }, // no PublishedPort AND no TargetPort — should be filtered out
        { PublishedPort: '6379', TargetPort: '6379', Protocol: 'tcp', URL: '127.0.0.1' },
      ],
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: internalPortEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as {
      success: true;
      services: { ports: { hostPort: string; hostIp: string }[] }[];
    };
    expect(success.services[0]?.ports).toHaveLength(1);
    expect(success.services[0]?.ports[0]?.hostPort).toBe('6379');
    expect(success.services[0]?.ports[0]?.hostIp).toBe('127.0.0.1');
  });

  it('handles service with no container ID (stopped without state)', async () => {
    mockExistsSync.mockReturnValue(true);

    const noIdEntry = JSON.stringify({
      Service: 'scheduler',
      Image: 'scheduler:latest',
      State: '',
      Status: '',
      Publishers: null,
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: noIdEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 }); // logs

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as {
      success: true;
      services: {
        containerId: string | null;
        status: string;
        health: { status: string };
      }[];
    };
    expect(success.services[0]?.containerId).toBeNull();
    expect(success.services[0]?.status).toBe('stopped');
    expect(success.services[0]?.health.status).toBe('none');
  });

  it('handles malformed JSON from docker inspect gracefully', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: samplePsEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'not valid json', stderr: '', code: 0 }) // bad inspect
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as {
      success: true;
      services: { health: { status: string } }[];
    };
    expect(success.services[0]?.health.status).toBe('none');
  });

  it('handles invalid NDJSON entries gracefully (returns empty services)', async () => {
    mockExistsSync.mockReturnValue(true);

    // Output starts with { but is invalid JSON — parse error → psEntries is empty
    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '{ this is not valid json\n', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; services: unknown[] };
    expect(success.services).toHaveLength(0);
  });

  it('normalizes unknown status string to unknown', async () => {
    mockExistsSync.mockReturnValue(true);

    const unknownStatusEntry = JSON.stringify({
      ID: 'bbb222',
      Service: 'proxy',
      Image: 'traefik:v3',
      State: 'paused', // none of the known patterns
      Status: 'Paused',
      Publishers: [],
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: unknownStatusEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as { success: true; services: { status: string }[] };
    expect(success.services[0]?.status).toBe('unknown');
  });

  it('handles non-string non-array ports gracefully', async () => {
    mockExistsSync.mockReturnValue(true);

    // Publishers as a number — hits the final `return []` branch
    const numericPortEntry = JSON.stringify({
      ID: 'ddd444',
      Service: 'api',
      Image: 'api:latest',
      State: 'running',
      Status: 'Up',
      Publishers: 42,
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: numericPortEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as { success: true; services: { ports: unknown[] }[] };
    expect(success.services[0]?.ports).toHaveLength(0);
  });

  it('handles string ports with non-matching format', async () => {
    mockExistsSync.mockReturnValue(true);

    // Ports as a string that doesn't match the host:port->port/proto pattern
    const badStringPortEntry = JSON.stringify({
      ID: 'ccc333',
      Service: 'mesh',
      Image: 'envoy:latest',
      State: 'running',
      Status: 'Up',
      Ports: 'something-invalid',
    });

    mockRun
      .mockResolvedValueOnce({ stdout: '27.0.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: badStringPortEntry, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'null', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 });

    const result = await dockerComposeStatus({ compose_file: '/app/docker-compose.yml' });

    const success = result as { success: true; services: { ports: unknown[] }[] };
    expect(success.services[0]?.ports).toHaveLength(0);
  });
});
