# mcp-dev-toolkit — Claude Code Instructions

## What This Project Is

An MCP (Model Context Protocol) server that gives Claude real development superpowers over a local codebase. Built with TypeScript strict mode, `@modelcontextprotocol/sdk` 1.29.0, Zod validation, Biome v2 linting, and Vitest.

The server exposes **7 tools** over stdio transport, each returning `{ error, details? }` on failure and a typed success payload on success.

## Project Layout

```
src/
  index.ts                  # MCP server entry point (McpServer + StdioServerTransport)
  tools/
    db-introspect.ts        # DB schema introspection (PG + MySQL)
    db-query-analyze.ts     # EXPLAIN ANALYZE plan parser (PG) + MySQL EXPLAIN
    symfony-routes.ts       # symfony debug:router → structured route list
    symfony-services.ts     # symfony debug:container → structured service list
    git-blame-context.ts    # git blame --porcelain parser with commit details
    docker-compose-status.ts  # docker compose ps NDJSON + inspect + logs
    openapi-validate.ts     # OpenAPI 3.x spec validation against live server
  utils/
    db-connection.ts        # Dynamic pg / mysql2 loader (peer deps, no hard require)
    shell.ts                # spawn() wrapper — NEVER string interpolation
tests/
  tools/
    *.test.ts               # Vitest unit tests (all mocked, no real DB/Docker needed)
```

## The 7 Tools

| Tool | Description |
|------|-------------|
| `db_introspect` | Introspect a PG or MySQL database: tables, columns (with type + nullable), indexes, foreign keys, row estimates |
| `db_query_analyze` | Run EXPLAIN ANALYZE inside a transaction (always ROLLBACKed), parse the plan tree, detect seq scans / row-count mismatches, surface suggestions |
| `symfony_routes` | Run `bin/console debug:router --format=json` and return a structured route list with optional filter |
| `symfony_services` | Run `bin/console debug:container --format=json` and return a structured service list with optional filter |
| `git_blame_context` | `git blame --porcelain` on a line range, parse all commits, return blame lines + unique commit details |
| `docker_compose_status` | `docker compose ps --format=json` (NDJSON), `docker inspect` for health, `docker compose logs` for tail |
| `openapi_validate` | Load an OpenAPI 3.x spec (file or URL), validate structure, then send real HTTP requests and check response shapes |

## Development Commands

```bash
npm run lint          # Biome check (src + tests) — must be clean before commit
npm run typecheck     # tsc --noEmit — zero errors required
npm test              # vitest run — all tests must pass
npm run test:coverage # vitest run --coverage — must meet thresholds
npm run build         # tsc → dist/
npm run lint:fix      # Biome auto-fix (safe rules only)
npm run format        # Biome format --write
```

## Key Implementation Rules

### Shell commands
`src/utils/shell.ts` exports `run(cmd, args, opts)` using `spawn(cmd, argsArray)`. **Never** build shell strings with user input. All Symfony and git commands go through `run()`.

### Database connections
`src/utils/db-connection.ts` dynamically imports `pg` or `mysql2/promise` via `import()`. Both are optional peer dependencies. Callers catch `createConnection()` rejections and return `{ error: 'Failed to connect: ...' }`. **Connection strings must never appear in logs.**

### Biome v2 linting rules
- `useLiteralKeys` — use typed row interfaces (`interface MyRow { col?: unknown; }`) and cast unknown rows before field access. Never `row['col']`.
- `suspicious.noConsole` — no `console.*` anywhere except `src/index.ts` (stderr only).
- `noParameterAssign` — never reassign a function parameter; use a `const` alias.
- `noNonNullAssertion` — no `!` assertions; use nullish coalescing or explicit checks.
- `noGlobalIsNan` — use `Number.isNaN()`, never `isNaN()`.
- `noExcessiveCognitiveComplexity` — split large functions; each function should do one thing.

### TypeScript strict flags
`tsconfig.json` enables `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Array index access returns `T | undefined`. Always guard with `?? defaultValue` or early return.

### Coverage thresholds
```
statements : 80%
functions  : 80%
branches   : 75%   ← tightest; MySQL + dynamic import branches need explicit tests
lines      : 80%
```

## Biome v2 Config Notes

`biome.json` uses v2 syntax:
- `files.includes` (not `files.ignore`)
- `suspicious.noConsole` (not `noConsoleLog`)
- `assist.actions.source.organizeImports` (organizeImports was moved from linter to assist in v2)

Do not revert these to v1 syntax — the installed `@biomejs/biome` is `2.4.15`.

## Test Patterns

### Mocking `run()`
```typescript
vi.mock('../../src/utils/shell.js', () => ({ run: vi.fn() }));
const mockRun = vi.mocked(run);
mockRun.mockResolvedValueOnce({ stdout: '...', stderr: '', code: 0 });
```

### Mocking `createConnection()` (db-connection)
```typescript
vi.mock('../../src/utils/db-connection.js', () => ({
  createConnection: vi.fn(),
  sanitizeConnectionString: vi.fn((cs) => cs.replace(/:\/\/[^@]+@/, '://****@')),
  detectDriver: vi.fn(),
}));
```

### Testing dynamic imports (`vi.doMock`)
For testing `db-connection.ts` loading `pg`/`mysql2` dynamically:
```typescript
// Must use vi.doMock (not vi.mock — no hoisting) + dynamic import after mock
vi.doMock('pg', () => ({ default: { Client: MockClientClass } }));
const { createConnection } = await import('../../src/utils/db-connection.js');
```

### Git blame hash fixtures
Git blame porcelain regex requires **exactly 40 hex chars**:
```typescript
const HASH_A = 'abc123456789012345678901234567890123abcd'; // exactly 40
```

## Integration Tests (skipped by default)

Tests gated on `TEST_POSTGRES_DSN` environment variable are skipped in normal CI. Run them locally with a real Postgres instance:
```bash
TEST_POSTGRES_DSN=postgresql://u:p@localhost/db npm test
```

## CI

`.github/workflows/ci.yml` — runs on Node 20 + 22, installs deps, runs lint + typecheck + test with coverage. No Docker or real DB required (all mocked).
