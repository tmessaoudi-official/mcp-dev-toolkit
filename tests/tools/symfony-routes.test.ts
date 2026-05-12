import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock fs and shell
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('../../src/utils/shell.js', () => ({
  run: vi.fn(),
}));

import { symfonyRoutes } from '../../src/tools/symfony-routes.js';
import { run } from '../../src/utils/shell.js';

const mockRun = vi.mocked(run);
const mockExistsSync = vi.mocked(existsSync);

const sampleRoutesJson = JSON.stringify({
  app_home: {
    path: '/',
    methods: ['GET'],
    defaults: { _controller: 'App\\Controller\\HomeController::index' },
    requirements: {},
    schemes: [],
    host: '',
  },
  app_users: {
    path: '/users/{id}',
    methods: ['GET', 'POST'],
    defaults: { _controller: 'App\\Controller\\UserController::show' },
    requirements: { id: '\\d+' },
    schemes: ['https'],
    host: '',
  },
});

describe('symfonyRoutes()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when bin/console not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await symfonyRoutes({ project_path: '/path/to/project' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Not a Symfony project');
  });

  it('returns structured routes for a valid Symfony project', async () => {
    mockExistsSync.mockReturnValue(true);

    // php --version (detect binary)
    mockRun.mockResolvedValueOnce({ stdout: 'PHP 8.3.0 (cli)', stderr: '', code: 0 });
    // debug:router
    mockRun.mockResolvedValueOnce({ stdout: sampleRoutesJson, stderr: '', code: 0 });
    // php --version (getPhpVersion)
    mockRun.mockResolvedValueOnce({ stdout: 'PHP 8.3.0 (cli)', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app' });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; totalRoutes: number; routes: { name: string }[] };
    expect(success.success).toBe(true);
    expect(success.totalRoutes).toBe(2);
    expect(success.routes.map((r) => r.name)).toContain('app_home');
  });

  it('filters routes by name when filter is provided', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: sampleRoutesJson, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app', filter: 'users' });

    const success = result as { success: true; totalRoutes: number; routes: { name: string }[] };
    expect(success.totalRoutes).toBe(1);
    expect(success.routes[0]?.name).toBe('app_users');
  });

  it('returns error when debug:router fails', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'No application kernel found', code: 1 });

    const result = await symfonyRoutes({ project_path: '/app' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('debug:router failed');
  });

  it('returns error when JSON output is malformed', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'not json at all', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('parse JSON');
  });

  it('returns ANY for routes with no methods specified', async () => {
    mockExistsSync.mockReturnValue(true);

    const noMethodRoutes = JSON.stringify({
      app_catch_all: {
        path: '/{any}',
        methods: [],
        defaults: { _controller: 'App\\Controller\\FallbackController::handle' },
        requirements: {},
        schemes: [],
        host: '',
      },
    });

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: noMethodRoutes, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app' });

    const success = result as { success: true; routes: { methods: string[] }[] };
    expect(success.routes[0]?.methods).toEqual(['ANY']);
  });

  it('falls back to controller field when _controller not in defaults', async () => {
    mockExistsSync.mockReturnValue(true);

    const routeWithControllerField = JSON.stringify({
      api_status: {
        path: '/status',
        methods: ['GET'],
        controller: 'App\\Controller\\StatusController::check',
        defaults: {},
        requirements: {},
        schemes: [],
        host: 'api.example.com',
      },
    });

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: routeWithControllerField, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app' });

    const success = result as {
      success: true;
      routes: { controller: string; host: string; methods: string[] }[];
    };
    expect(success.routes[0]?.controller).toBe('App\\Controller\\StatusController::check');
    expect(success.routes[0]?.host).toBe('api.example.com');
  });

  it('uses string method when methods is a non-empty string', async () => {
    mockExistsSync.mockReturnValue(true);

    const stringMethodRoute = JSON.stringify({
      api_ping: {
        path: '/ping',
        methods: 'GET',
        defaults: {},
        requirements: {},
        schemes: [],
        host: '',
      },
    });

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: stringMethodRoute, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyRoutes({ project_path: '/app' });

    const success = result as { success: true; routes: { methods: string[] }[] };
    expect(success.routes[0]?.methods).toEqual(['GET']);
  });

  it('falls back to php when all versioned binaries fail', async () => {
    mockExistsSync.mockReturnValue(true);

    // All php binary detections fail except the first 'php' attempt
    // 'php' is tried first and succeeds
    mockRun
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php8.4 fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php8.3 fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php8.2 fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php8.1 fails
      .mockResolvedValueOnce({ stdout: '', stderr: 'command not found', code: 127 }) // php8.0 fails
      // debug:router runs with 'php' (fallback)
      .mockResolvedValueOnce({ stdout: sampleRoutesJson, stderr: '', code: 0 })
      // getPhpVersion with fallback php binary
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 1 });

    const result = await symfonyRoutes({ project_path: '/app' });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; phpVersion: string | null };
    expect(success.phpVersion).toBeNull();
  });
});
