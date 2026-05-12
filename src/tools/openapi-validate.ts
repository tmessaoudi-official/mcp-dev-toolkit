/**
 * openapi_validate — Loads an OpenAPI spec (file or URL), validates endpoints
 * against a running base URL, and reports drift between spec and reality.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const OpenApiValidateInput = z.object({
  spec_path: z
    .string()
    .min(1)
    .describe('Path to OpenAPI spec file (JSON or YAML) OR a URL to fetch the spec from'),
  base_url: z.string().url().describe('Base URL of the running API to validate against'),
  sample_count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum number of endpoints to sample (default: 10)'),
});

export type OpenApiValidateInput = z.infer<typeof OpenApiValidateInput>;

export interface EndpointValidation {
  method: string;
  path: string;
  operationId: string | null;
  requestUrl: string;
  expectedStatuses: number[];
  actualStatus: number | null;
  statusMatch: boolean;
  responseBodyValid: boolean | null;
  responseTimeMs: number | null;
  driftReasons: string[];
  error: string | null;
}

export interface OpenApiValidateResult {
  success: true;
  specSource: string;
  baseUrl: string;
  apiTitle: string;
  apiVersion: string;
  totalEndpoints: number;
  sampledEndpoints: number;
  validations: EndpointValidation[];
  summary: {
    passed: number;
    failed: number;
    errored: number;
    driftDetected: boolean;
  };
}

export interface OpenApiValidateError {
  error: string;
  details?: Record<string, unknown>;
}

// Typed OpenAPI structures
interface OpenApiInfo {
  title?: string;
  version?: string;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: Record<string, unknown>[];
  requestBody?: { required?: boolean };
  responses?: Record<string, unknown>;
}

interface OpenApiPathItem {
  parameters?: Record<string, unknown>[];
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  patch?: OpenApiOperation;
  delete?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
}

interface OpenApiSpec {
  info?: OpenApiInfo;
  paths?: Record<string, OpenApiPathItem>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function openApiValidate(
  input: OpenApiValidateInput,
): Promise<OpenApiValidateResult | OpenApiValidateError> {
  // Load spec
  const specResult = await loadSpec(input.spec_path);
  if ('error' in specResult) return specResult;

  const { spec, source } = specResult;

  // Parse endpoints from spec
  const endpoints = extractEndpoints(spec);
  if (endpoints.length === 0) {
    return {
      error: 'No endpoints found in OpenAPI spec',
      details: { specSource: source, paths: Object.keys(spec.paths ?? {}).length },
    };
  }

  // Sample endpoints (skip ones requiring complex auth or body for GET-only sampling)
  const sampled = sampleEndpoints(endpoints, input.sample_count ?? 10);

  // Validate each endpoint
  const validations = await Promise.all(
    sampled.map((ep) => validateEndpoint(ep, input.base_url, spec)),
  );

  const passed = validations.filter(
    (v) => v.statusMatch && v.driftReasons.length === 0 && !v.error,
  ).length;
  const failed = validations.filter(
    (v) => (!v.statusMatch || v.driftReasons.length > 0) && !v.error,
  ).length;
  const errored = validations.filter((v) => v.error !== null).length;

  return {
    success: true,
    specSource: source,
    baseUrl: input.base_url,
    apiTitle: String(spec.info?.title ?? 'Unknown API'),
    apiVersion: String(spec.info?.version ?? 'unknown'),
    totalEndpoints: endpoints.length,
    sampledEndpoints: sampled.length,
    validations,
    summary: {
      passed,
      failed,
      errored,
      driftDetected: failed > 0 || errored > 0,
    },
  };
}

interface SpecLoadResult {
  spec: OpenApiSpec;
  source: string;
}

interface ParseSpecSuccess {
  spec: OpenApiSpec;
}

function parseSpecText(text: string, hint: string): ParseSpecSuccess | OpenApiValidateError {
  // Try JSON first
  try {
    return { spec: JSON.parse(text) as OpenApiSpec };
  } catch {
    if (hint.endsWith('.json')) {
      return { error: 'Spec file has .json extension but failed to parse as JSON' };
    }
    // Parse as YAML (covers JSON-as-YAML, anchors, multi-doc, etc.)
    try {
      const parsed = parseYaml(text) as OpenApiSpec;
      if (typeof parsed !== 'object' || parsed === null) {
        return {
          error: 'YAML parsed but result is not an object',
          details: { hint } as Record<string, unknown>,
        };
      }
      return { spec: parsed };
    } catch (yamlErr) {
      return {
        error: `Failed to parse spec as JSON or YAML: ${yamlErr instanceof Error ? yamlErr.message : String(yamlErr)}`,
        details: { hint, preview: text.slice(0, 200) } as Record<string, unknown>,
      };
    }
  }
}

async function fetchSpec(specPath: string): Promise<SpecLoadResult | OpenApiValidateError> {
  try {
    const response = await fetch(specPath, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      return { error: `Failed to fetch spec from ${specPath}: HTTP ${response.status}` };
    }
    const text = await response.text();
    const parsed = parseSpecText(text, specPath);
    if ('error' in parsed) return parsed;
    return { spec: parsed.spec, source: specPath };
  } catch (err) {
    return { error: `Failed to fetch spec: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function readFileSpec(specPath: string): Promise<SpecLoadResult | OpenApiValidateError> {
  if (!existsSync(specPath)) {
    return { error: `Spec file not found: ${specPath}` };
  }
  try {
    const text = readFileSync(specPath, 'utf-8');
    const parsed = parseSpecText(text, specPath);
    if ('error' in parsed) return parsed;
    return { spec: parsed.spec, source: specPath };
  } catch (err) {
    return {
      error: `Failed to read spec file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function loadSpec(specPath: string): Promise<SpecLoadResult | OpenApiValidateError> {
  if (specPath.startsWith('http://') || specPath.startsWith('https://')) {
    return fetchSpec(specPath);
  }
  return readFileSpec(specPath);
}

interface EndpointDef {
  method: string;
  path: string;
  operationId: string | null;
  expectedStatuses: number[];
  parameters: ParameterDef[];
  hasRequiredBody: boolean;
}

interface ParameterDef {
  name: string;
  in: string;
  required: boolean;
  schema: Record<string, unknown>;
  example: unknown;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

function extractEndpoints(spec: OpenApiSpec): EndpointDef[] {
  const paths = spec.paths ?? {};
  const endpoints: EndpointDef[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;

      const responses = op.responses ?? {};
      const expectedStatuses = Object.keys(responses)
        .map(Number)
        .filter((n) => !Number.isNaN(n));

      const rawParams = (op.parameters ?? pathItem.parameters ?? []) as Record<string, unknown>[];
      const parameters = parseParameters(rawParams, spec);

      const hasRequiredBody = op.requestBody !== undefined && op.requestBody.required === true;

      endpoints.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId != null ? String(op.operationId) : null,
        expectedStatuses,
        parameters,
        hasRequiredBody,
      });
    }
  }

  return endpoints;
}

interface ParameterSchema {
  example?: unknown;
}

interface RawParameter {
  $ref?: string;
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: ParameterSchema;
  example?: unknown;
}

function parseParameters(raw: Record<string, unknown>[], spec: OpenApiSpec): ParameterDef[] {
  return raw.map((rawP) => {
    const p = rawP as RawParameter;
    // Resolve $ref if present
    const resolved = typeof p.$ref === 'string' ? resolveRef(p.$ref, spec) : null;
    const param = resolved ?? p;

    const rp = param as RawParameter;
    return {
      name: String(rp.name ?? ''),
      in: String(rp.in ?? 'query'),
      required: Boolean(rp.required ?? false),
      schema: (rp.schema ?? {}) as Record<string, unknown>,
      example: rp.example ?? rp.schema?.example,
    };
  });
}

function resolveRef(ref: string, spec: OpenApiSpec): RawParameter | null {
  const parts = ref.replace(/^#\//, '').split('/');
  let current: unknown = spec;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current as RawParameter | null;
}

function sampleEndpoints(endpoints: EndpointDef[], count: number): EndpointDef[] {
  // Prefer GET endpoints without required body for easier sampling
  const gets = endpoints.filter((e) => e.method === 'GET' && !e.hasRequiredBody);
  const others = endpoints.filter((e) => e.method !== 'GET' || e.hasRequiredBody);

  const selected = [...gets.slice(0, Math.min(count, gets.length))];
  const remaining = count - selected.length;
  if (remaining > 0) {
    selected.push(...others.slice(0, remaining));
  }

  return selected;
}

async function validateEndpoint(
  ep: EndpointDef,
  baseUrl: string,
  _spec: OpenApiSpec,
): Promise<EndpointValidation> {
  const requestUrl = buildRequestUrl(ep, baseUrl);
  const driftReasons: string[] = [];
  let actualStatus: number | null = null;
  let responseBodyValid: boolean | null = null;
  let responseTimeMs: number | null = null;
  let error: string | null = null;

  // Skip non-GET with required body — can't safely make test requests
  if (ep.method !== 'GET' && ep.hasRequiredBody) {
    return {
      method: ep.method,
      path: ep.path,
      operationId: ep.operationId,
      requestUrl,
      expectedStatuses: ep.expectedStatuses,
      actualStatus: null,
      statusMatch: false,
      responseBodyValid: null,
      responseTimeMs: null,
      driftReasons: [
        'Skipped: endpoint requires a request body (non-GET mutation skipped for safety)',
      ],
      error: null,
    };
  }

  try {
    const start = Date.now();
    const response = await fetch(requestUrl, {
      method: ep.method,
      headers: { Accept: 'application/json', 'User-Agent': 'mcp-dev-toolkit/1.0.0' },
      signal: AbortSignal.timeout(15_000),
    });
    responseTimeMs = Date.now() - start;
    actualStatus = response.status;
    const statusCode = actualStatus;

    // Status validation
    const statusMatch =
      ep.expectedStatuses.length === 0 ||
      ep.expectedStatuses.includes(statusCode) ||
      ep.expectedStatuses.some((s) => Math.floor(s / 100) === Math.floor(statusCode / 100));

    if (!statusMatch) {
      driftReasons.push(`Expected status [${ep.expectedStatuses.join(', ')}], got ${actualStatus}`);
    }

    // Response body shape validation (basic)
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json') && response.body) {
      try {
        const body = (await response.json()) as unknown;
        const bodyDrift = validateResponseShape(body, actualStatus);
        driftReasons.push(...bodyDrift);
        responseBodyValid = bodyDrift.length === 0;
      } catch {
        driftReasons.push('Response body is not valid JSON despite Content-Type: application/json');
        responseBodyValid = false;
      }
    }

    return {
      method: ep.method,
      path: ep.path,
      operationId: ep.operationId,
      requestUrl,
      expectedStatuses: ep.expectedStatuses,
      actualStatus,
      statusMatch,
      responseBodyValid,
      responseTimeMs,
      driftReasons,
      error: null,
    };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    return {
      method: ep.method,
      path: ep.path,
      operationId: ep.operationId,
      requestUrl,
      expectedStatuses: ep.expectedStatuses,
      actualStatus: null,
      statusMatch: false,
      responseBodyValid: null,
      responseTimeMs,
      driftReasons,
      error,
    };
  }
}

function buildRequestUrl(ep: EndpointDef, baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  let path = ep.path;

  // Fill path parameters with example values
  for (const param of ep.parameters.filter((p) => p.in === 'path')) {
    const example = param.example ?? getSchemaExample(param.schema);
    path = path.replace(`{${param.name}}`, encodeURIComponent(String(example ?? '1')));
  }

  // Add required query parameters with examples
  const queryParams = ep.parameters.filter((p) => p.in === 'query' && p.required);
  if (queryParams.length > 0) {
    const qs = queryParams
      .map((p) => {
        const val = p.example ?? getSchemaExample(p.schema) ?? '';
        return `${encodeURIComponent(p.name)}=${encodeURIComponent(String(val))}`;
      })
      .join('&');
    path = `${path}?${qs}`;
  }

  return `${base}${path}`;
}

interface SchemaWithExample {
  example?: unknown;
  default?: unknown;
  type?: string;
}

function getSchemaExample(schema: Record<string, unknown>): unknown {
  const s = schema as SchemaWithExample;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  switch (s.type) {
    case 'integer':
      return 1;
    case 'number':
      return 1.0;
    case 'boolean':
      return true;
    case 'string':
      return 'string';
    default:
      return null;
  }
}

interface ErrorResponseBody {
  message?: unknown;
  error?: unknown;
  detail?: unknown;
  errors?: unknown;
}

function validateResponseShape(body: unknown, status: number): string[] {
  const drift: string[] = [];

  // Basic shape checks
  if (status >= 200 && status < 300) {
    if (body === null || body === undefined) {
      drift.push('Success response body is null/undefined');
    }
  }

  if (status >= 400 && typeof body === 'object' && body !== null) {
    const errorBody = body as ErrorResponseBody;
    // Many APIs should return error details
    if (!errorBody.message && !errorBody.error && !errorBody.detail && !errorBody.errors) {
      drift.push('Error response missing standard error field (message/error/detail/errors)');
    }
  }

  return drift;
}
