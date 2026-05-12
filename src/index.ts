#!/usr/bin/env node
/**
 * mcp-dev-toolkit — MCP server entry point.
 *
 * Registers all 7 developer tools and starts the stdio transport.
 * Usage: npx mcp-dev-toolkit  OR  node dist/index.js
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { DbIntrospectInput, dbIntrospect } from './tools/db-introspect.js';
import { DbQueryAnalyzeInput, dbQueryAnalyze } from './tools/db-query-analyze.js';
import { DockerComposeStatusInput, dockerComposeStatus } from './tools/docker-compose-status.js';
import { GitBlameContextInput, gitBlameContext } from './tools/git-blame-context.js';
import { OpenApiValidateInput, openApiValidate } from './tools/openapi-validate.js';
import { SymfonyRoutesInput, symfonyRoutes } from './tools/symfony-routes.js';
import { SymfonyServicesInput, symfonyServices } from './tools/symfony-services.js';

const server = new McpServer({
  name: 'mcp-dev-toolkit',
  version: '1.0.0',
});

// ── Tool: db_introspect ────────────────────────────────────────────────────────
server.tool(
  'db_introspect',
  'Introspects a PostgreSQL or MySQL database and returns structured schema information: ' +
    'tables, columns (name, type, nullable, default), primary keys, foreign keys, and indexes.',
  DbIntrospectInput.shape,
  async (args) => {
    const result = await dbIntrospect(DbIntrospectInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: db_query_analyze ─────────────────────────────────────────────────────
server.tool(
  'db_query_analyze',
  'Runs EXPLAIN ANALYZE on a SQL query and returns the execution plan, estimated vs actual rows, ' +
    'slow nodes (>50% of total time), index usage summary, and plain-language optimization suggestions.',
  DbQueryAnalyzeInput.shape,
  async (args) => {
    const result = await dbQueryAnalyze(DbQueryAnalyzeInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: symfony_routes ───────────────────────────────────────────────────────
server.tool(
  'symfony_routes',
  'Lists all routes in a Symfony project by running bin/console debug:router --format=json. ' +
    'Returns route name, path, HTTP methods, controller, requirements, and schemes. ' +
    'Falls back gracefully if the path is not a Symfony project.',
  SymfonyRoutesInput.shape,
  async (args) => {
    const result = await symfonyRoutes(SymfonyRoutesInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: symfony_services ─────────────────────────────────────────────────────
server.tool(
  'symfony_services',
  'Lists Symfony DI container services by running bin/console debug:container --format=json. ' +
    'Returns service id, class, tags, aliases, and visibility (public/private).',
  SymfonyServicesInput.shape,
  async (args) => {
    const result = await symfonyServices(SymfonyServicesInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: git_blame_context ────────────────────────────────────────────────────
server.tool(
  'git_blame_context',
  'Returns git blame information for a file line range: which commits last touched each line, ' +
    'with commit hash, author, date, and message for each unique commit.',
  GitBlameContextInput.shape,
  async (args) => {
    const result = await gitBlameContext(GitBlameContextInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: docker_compose_status ────────────────────────────────────────────────
server.tool(
  'docker_compose_status',
  'Returns Docker Compose service status: running/stopped/unhealthy state, port bindings, ' +
    'last 20 log lines per container, and health check results.',
  DockerComposeStatusInput.shape,
  async (args) => {
    const result = await dockerComposeStatus(DockerComposeStatusInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Tool: openapi_validate ─────────────────────────────────────────────────────
server.tool(
  'openapi_validate',
  'Loads an OpenAPI spec (file path or URL) and validates sampled endpoints against a running base URL. ' +
    'Compares response status codes and shape to the spec definition, and reports drift.',
  OpenApiValidateInput.shape,
  async (args) => {
    const result = await openApiValidate(OpenApiValidateInput.parse(args));
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

// ── Start server ───────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
