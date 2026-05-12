# mcp-dev-toolkit — Project Config

## What This Project Is

An MCP (Model Context Protocol) server written in TypeScript that gives Claude (or any MCP client)
structured access to a local development codebase. It runs over stdio transport.

## Project Structure

```
src/
  index.ts               # MCP server entry point — registers all 7 tools
  tools/
    db-introspect.ts     # PostgreSQL/MySQL schema introspection
    db-query-analyze.ts  # EXPLAIN ANALYZE wrapper with suggestions
    symfony-routes.ts    # Symfony debug:router wrapper
    symfony-services.ts  # Symfony debug:container wrapper
    git-blame-context.ts # git blame + log for a line range
    docker-compose-status.ts  # docker compose ps + logs + health
    openapi-validate.ts  # OpenAPI spec vs live API drift detection
  utils/
    db-connection.ts     # DB driver abstraction (pg / mysql2, lazy load)
    shell.ts             # Safe spawn wrapper (no string interpolation)
tests/
  tools/                 # Unit tests (mocked externals) — one file per tool
  integration/           # Integration tests (testcontainers, real DB)
```

## Key Design Decisions

- **No shell string interpolation** — `shell.ts` always uses `spawn()` with an args array.
- **Credentials never logged** — `sanitizeConnectionString()` strips passwords before any error message.
- **pg and mysql2 are optional peer deps** — loaded dynamically via `import()` based on connection string prefix.
- **All tools return structured errors** — never throw to the MCP layer; always `{ error, details? }`.
- **Query rollback** — `db_query_analyze` wraps EXPLAIN ANALYZE in a transaction that is always rolled back.

## Toolchain

- **TypeScript** with strict mode + `noUncheckedIndexedAccess`
- **Biome v2** — replaces ESLint + Prettier (single tool for lint + format)
- **Vitest** — test runner with v8 coverage
- **MCP SDK** — `@modelcontextprotocol/sdk` (stdio transport)
- **Zod** — input schema validation (same schemas exposed as MCP JSON Schema)

## Common Commands

```bash
npm run build        # Compile TypeScript → dist/
npm run typecheck    # tsc --noEmit (no emit, just check)
npm run lint         # biome check src tests
npm run lint:fix     # biome check --write src tests
npm test             # vitest run (all unit tests)
npm run test:coverage  # vitest with coverage report
```

## Adding a New Tool

1. Create `src/tools/<name>.ts` with:
   - A named Zod schema `export const MyInput = z.object({...})`
   - An async function `export async function myTool(input: MyInput): Promise<Result | ErrorResult>`
   - All errors caught and returned as `{ error: string, details?: object }`

2. Register in `src/index.ts`:
   ```typescript
   import { MyInput, myTool } from './tools/my-tool.js';
   server.tool('my_tool', 'Description', MyInput.shape, async (args) => {
     const result = await myTool(MyInput.parse(args));
     return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
   });
   ```

3. Add unit tests in `tests/tools/<name>.test.ts` — mock all external calls.

## Security Notes

- Shell commands: always `spawn(cmd, argsArray)`, never `exec('cmd ' + userInput)`
- DB credentials: pass directly to pg/mysql2 drivers, never log or interpolate into SQL
- Docker socket: the Dockerfile mounts `/var/run/docker.sock` — document this clearly in README
- OpenAPI validation: only makes GET requests by default; POST/PUT/DELETE with required bodies are skipped

## Global Rules

The global reasoning framework from `~/.claude/CLAUDE.md` applies: 8-phase workflow,
Completion Gate (Rule 6), TDD (Rule 7), security-first (Rule 2).
