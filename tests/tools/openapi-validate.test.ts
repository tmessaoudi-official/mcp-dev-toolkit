import { existsSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { openApiValidate } from '../../src/tools/openapi-validate.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

const sampleSpec = {
  openapi: '3.0.0',
  info: { title: 'Test API', version: '1.0.0' },
  paths: {
    '/users': {
      get: {
        operationId: 'listUsers',
        responses: { '200': { description: 'OK' } },
        parameters: [],
      },
      post: {
        operationId: 'createUser',
        requestBody: { required: true, content: {} },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/users/{id}': {
      get: {
        operationId: 'getUser',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: {
          '200': { description: 'OK' },
          '404': { description: 'Not found' },
        },
      },
    },
  },
};

describe('openApiValidate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when spec file not found', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await openApiValidate({
      spec_path: '/nonexistent/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 5,
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('not found');
  });

  it('returns error when spec file is invalid JSON', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not { valid json }' as unknown as Buffer);

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 5,
    });

    expect(result).toHaveProperty('error');
  });

  it('validates endpoints and returns results', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleSpec) as unknown as Buffer);

    // Mock fetch for /users endpoint
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      body: {},
      json: vi.fn().mockResolvedValue([{ id: 1 }]),
    });

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 10,
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      apiTitle: string;
      apiVersion: string;
      validations: { method: string; path: string }[];
      summary: { passed: number; failed: number };
    };
    expect(success.success).toBe(true);
    expect(success.apiTitle).toBe('Test API');
    expect(success.apiVersion).toBe('1.0.0');
    expect(success.validations.length).toBeGreaterThan(0);
  });

  it('reports drift when status does not match spec', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleSpec) as unknown as Buffer);

    // Return 500 for a GET endpoint that expects 200
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      body: {},
      json: vi.fn().mockResolvedValue({}),
    });

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 10,
    });

    const success = result as {
      success: true;
      summary: { failed: number; driftDetected: boolean };
      validations: { driftReasons: string[]; statusMatch: boolean }[];
    };
    expect(success.success).toBe(true);
    expect(success.summary.driftDetected).toBe(true);
    expect(success.validations.some((v) => !v.statusMatch)).toBe(true);
  });

  it('loads spec from URL', async () => {
    // Two fetch calls: one for spec, one for endpoint validation
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        text: vi.fn().mockResolvedValue(JSON.stringify(sampleSpec)),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: vi.fn().mockResolvedValue([]),
      });

    const result = await openApiValidate({
      spec_path: 'http://localhost:8080/openapi.json',
      base_url: 'http://localhost:3000',
      sample_count: 2,
    });

    expect(result).not.toHaveProperty('error');
    const success = result as { success: true; specSource: string };
    expect(success.specSource).toBe('http://localhost:8080/openapi.json');
  });

  it('skips endpoints with required request body for safety', async () => {
    const specWithPost = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/items': {
          post: {
            operationId: 'createItem',
            requestBody: { required: true, content: {} },
            responses: { '201': { description: 'Created' } },
          },
        },
      },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(specWithPost) as unknown as Buffer);

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 10,
    });

    const success = result as {
      success: true;
      validations: { driftReasons: string[] }[];
    };
    expect(success.success).toBe(true);
    // The POST endpoint should be skipped with a message
    expect(success.validations[0]?.driftReasons.some((r) => r.includes('Skipped'))).toBe(true);
    // fetch should NOT have been called for the endpoint
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('items'), expect.anything());
  });

  it('returns error when spec has no paths/endpoints', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        openapi: '3.0.0',
        info: { title: 'Empty', version: '1.0.0' },
        paths: {},
      }) as unknown as Buffer,
    );

    const result = await openApiValidate({
      spec_path: '/empty.json',
      base_url: 'http://localhost:3000',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('No endpoints found');
  });

  it('returns error when URL fetch fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const result = await openApiValidate({
      spec_path: 'http://localhost:9999/openapi.json',
      base_url: 'http://localhost:3000',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Failed to fetch spec');
  });

  it('handles fetch network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await openApiValidate({
      spec_path: 'http://localhost:9999/openapi.json',
      base_url: 'http://localhost:3000',
    });

    expect(result).toHaveProperty('error');
  });

  it('handles error response body with missing error fields', async () => {
    const specWithGet = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      paths: {
        '/check': {
          get: {
            operationId: 'check',
            responses: { '400': { description: 'Bad request' } },
          },
        },
      },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(specWithGet) as unknown as Buffer);

    // Return 400 with a body that has no standard error field
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      body: {},
      json: vi.fn().mockResolvedValue({ code: 'BAD_REQUEST' }), // no message/error/detail/errors
    });

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 5,
    });

    const success = result as {
      success: true;
      validations: { driftReasons: string[]; responseBodyValid: boolean | null }[];
    };
    expect(success.success).toBe(true);
    expect(
      success.validations[0]?.driftReasons.some((r) => r.includes('missing standard error field')),
    ).toBe(true);
  });

  it('handles fetch error during endpoint validation', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(sampleSpec) as unknown as Buffer);

    // All endpoint fetches throw
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
      sample_count: 2,
    });

    const success = result as {
      success: true;
      validations: { error: string | null }[];
      summary: { errored: number };
    };
    expect(success.success).toBe(true);
    expect(success.summary.errored).toBeGreaterThan(0);
    expect(success.validations.some((v) => v.error !== null)).toBe(true);
  });

  it('resolves $ref parameters in path specs', async () => {
    const specWithRef = {
      openapi: '3.0.0',
      info: { title: 'API', version: '1.0.0' },
      components: {
        parameters: {
          UserId: {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'integer', example: 42 },
          },
        },
      },
      paths: {
        '/users/{id}': {
          get: {
            operationId: 'getUser',
            parameters: [{ $ref: '#/components/parameters/UserId' }],
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    };

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(specWithRef) as unknown as Buffer);

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: {},
      json: vi.fn().mockResolvedValue({}),
    });

    const result = await openApiValidate({
      spec_path: '/spec.json',
      base_url: 'http://localhost:3000',
    });

    const success = result as {
      success: true;
      validations: { requestUrl: string }[];
    };
    // Should have substituted the id=42 example into the URL
    expect(success.validations[0]?.requestUrl).toContain('42');
  });

  it('handles YAML-like spec (strips comments)', async () => {
    // A spec that looks like YAML but is valid JSON after stripping # comments
    const yamlLikeSpec = `# OpenAPI spec
${JSON.stringify({ openapi: '3.0.0', info: { title: 'YAML API', version: '2.0.0' }, paths: {} })}`;

    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(yamlLikeSpec as unknown as Buffer);

    const result = await openApiValidate({
      spec_path: '/spec.yaml',
      base_url: 'http://localhost:3000',
    });

    // Should fail with "No endpoints" since paths is empty, not a parse error
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('No endpoints');
  });
});
