import { existsSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('../../src/utils/shell.js', () => ({
  run: vi.fn(),
}));

import { symfonyServices } from '../../src/tools/symfony-services.js';
import { run } from '../../src/utils/shell.js';

const mockRun = vi.mocked(run);
const mockExistsSync = vi.mocked(existsSync);

const sampleServicesJson = JSON.stringify([
  {
    id: 'App\\Service\\UserService',
    class: 'App\\Service\\UserService',
    public: false,
    abstract: false,
    synthetic: false,
    lazy: false,
    shared: true,
    tags: [{ name: 'app.service', priority: 0 }],
    aliases: [],
    decorates: null,
  },
  {
    id: 'Symfony\\Component\\HttpKernel\\KernelInterface',
    class: null,
    public: true,
    abstract: false,
    synthetic: true,
    lazy: false,
    shared: true,
    tags: [],
    aliases: ['kernel'],
    decorates: null,
  },
]);

describe('symfonyServices()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when bin/console not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await symfonyServices({ project_path: '/nope' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Not a Symfony project');
  });

  it('returns services list for a valid Symfony project', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 }) // detect PHP
      .mockResolvedValueOnce({ stdout: sampleServicesJson, stderr: '', code: 0 }) // debug:container
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 }); // getPhpVersion

    const result = await symfonyServices({ project_path: '/app' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      totalServices: number;
      services: { id: string; public: boolean }[];
    };
    expect(success.success).toBe(true);
    expect(success.totalServices).toBe(2);
    expect(success.services[0]?.id).toBe('App\\Service\\UserService');
    expect(success.services[1]?.public).toBe(true);
  });

  it('filters services by id substring', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: sampleServicesJson, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app', filter: 'UserService' });

    const success = result as { success: true; totalServices: number };
    expect(success.totalServices).toBe(1);
  });

  it('returns error when debug:container fails', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'Kernel not found', code: 1 });

    const result = await symfonyServices({ project_path: '/app' });

    expect(result).toHaveProperty('error');
  });

  it('handles object-keyed service output (legacy format)', async () => {
    mockExistsSync.mockReturnValue(true);

    const objectFormat = JSON.stringify({
      'my.service': {
        class: 'My\\Service',
        public: true,
        abstract: false,
        synthetic: false,
        lazy: true,
        shared: true,
        tags: {},
        aliases: [],
        decorates: null,
      },
    });

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: objectFormat, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    const success = result as { success: true; services: { id: string; lazy: boolean }[] };
    expect(success.services[0]?.id).toBe('my.service');
    expect(success.services[0]?.lazy).toBe(true);
  });

  it('returns error when JSON output is malformed', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'not valid json {{{', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('parse JSON');
  });

  it('handles services with array tags and string aliases', async () => {
    mockExistsSync.mockReturnValue(true);

    const complexServicesJson = JSON.stringify([
      {
        id: 'App\\Service\\EventDispatcher',
        class: 'App\\Service\\EventDispatcher',
        public: false,
        abstract: false,
        synthetic: false,
        lazy: false,
        shared: true,
        // tags as array with name field
        tags: [
          { name: 'kernel.event_listener', event: 'kernel.request', priority: 8 },
          { name: 'kernel.event_subscriber' },
        ],
        // aliases as string instead of array
        aliases: 'event_dispatcher',
        decorates: 'Symfony\\Component\\EventDispatcher\\EventDispatcherInterface',
      },
    ]);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: complexServicesJson, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    const success = result as {
      success: true;
      services: {
        id: string;
        tags: { name: string; attributes: Record<string, unknown> }[];
        aliases: string[];
        decorates: string | null;
      }[];
    };
    expect(success.services[0]?.tags).toHaveLength(2);
    expect(success.services[0]?.tags[0]?.name).toBe('kernel.event_listener');
    expect(success.services[0]?.tags[0]?.attributes).toHaveProperty('event');
    expect(success.services[0]?.aliases).toEqual(['event_dispatcher']);
    expect(success.services[0]?.decorates).toBe(
      'Symfony\\Component\\EventDispatcher\\EventDispatcherInterface',
    );
  });

  it('filters services by class name substring', async () => {
    mockExistsSync.mockReturnValue(true);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: sampleServicesJson, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app', filter: 'kernel' });

    const success = result as { success: true; totalServices: number; services: { id: string }[] };
    expect(success.totalServices).toBe(1);
    expect(success.services[0]?.id).toContain('Kernel');
  });

  it('defaults shared to true when not specified in service definition', async () => {
    mockExistsSync.mockReturnValue(true);

    const noSharedService = JSON.stringify([
      {
        id: 'App\\Service\\Transient',
        class: 'App\\Service\\Transient',
        public: false,
        abstract: false,
        synthetic: false,
        lazy: false,
        // shared is absent — should default to true
        tags: [],
        aliases: [],
        decorates: null,
      },
    ]);

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: noSharedService, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    const success = result as { success: true; services: { shared: boolean }[] };
    expect(success.services[0]?.shared).toBe(true);
  });

  it('handles object-format tags with attributes', async () => {
    mockExistsSync.mockReturnValue(true);

    // Object-keyed format where tags is a non-empty object map
    const objectTagServices = JSON.stringify({
      'twig.extension': {
        class: 'App\\Twig\\AppExtension',
        public: false,
        abstract: false,
        synthetic: false,
        lazy: false,
        shared: true,
        tags: {
          'twig.extension': { priority: 0 },
          'kernel.reset': { method: 'reset' },
        },
        aliases: [],
        decorates: null,
      },
    });

    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: objectTagServices, stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    const success = result as {
      success: true;
      services: { tags: { name: string; attributes: Record<string, unknown> }[] }[];
    };
    expect(success.services[0]?.tags).toHaveLength(2);
    expect(success.services[0]?.tags.map((t) => t.name)).toContain('twig.extension');
    expect(success.services[0]?.tags.map((t) => t.name)).toContain('kernel.reset');
    expect(success.services[0]?.tags[1]?.attributes).toHaveProperty('method');
  });

  it('returns empty services array when debug:container output is not array or object', async () => {
    mockExistsSync.mockReturnValue(true);

    // Output is a scalar (unlikely but should not crash)
    mockRun
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '"just a string"', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: 'PHP 8.3.0', stderr: '', code: 0 });

    const result = await symfonyServices({ project_path: '/app' });

    const success = result as { success: true; totalServices: number };
    expect(success.success).toBe(true);
    expect(success.totalServices).toBe(0);
  });
});
