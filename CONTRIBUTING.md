# Contributing to mcp-dev-toolkit

## Prerequisites

- Node.js 20+
- npm 10+
- Docker (for integration tests with real databases)

## Getting started

```bash
git clone https://github.com/takieddine-messaoudi/mcp-dev-toolkit
cd mcp-dev-toolkit
npm install
npm run build
```

## Development workflow

```bash
npm run typecheck     # tsc --noEmit (zero errors required)
npm run lint          # Biome v2 check
npm run lint:fix      # Biome auto-fix
npm test              # Vitest unit tests (all mocked — no DB/Docker needed)
npm run test:coverage # Coverage report (must meet 80% thresholds)
```

## Adding a new tool

1. Create `src/tools/<name>.ts`:
   - Export a Zod schema for inputs
   - Export an async function returning `Result | { error: string }`
   - Use `src/utils/shell.ts` for any subprocess calls (never string interpolation)
2. Register in `src/index.ts` via `server.tool()`
3. Add unit tests in `tests/tools/<name>.test.ts` — mock all external calls

## Security rules

- Shell commands: always `spawn(cmd, argsArray)` — never template strings with user input
- DB credentials: never log them; use `sanitizeConnectionString()` before any error message
- All tools return `{ error }` on failure — never throw to the MCP layer

## Code style

Biome v2 enforces all style rules. Key rules:
- `useLiteralKeys` — typed row interfaces, no `row['col']`
- `noConsole` anywhere except `src/index.ts`
- `noNonNullAssertion` — use nullish coalescing

## Pull requests

1. Fork and create a branch (`feat/add-<name>-tool`)
2. All tests must pass: `npm test && npm run typecheck && npm run lint`
3. Coverage must not drop below thresholds: `npm run test:coverage`
4. Open a PR with a description of the new tool, its inputs/outputs, and sample output
