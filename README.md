# mcp-dev-toolkit

An MCP (Model Context Protocol) server that gives Claude — or any MCP client — real superpowers over a local development codebase.

Implemented in TypeScript. Runs over stdio. Install once, use from any project.

## What It Does

Seven tools, each addressing a common developer workflow:

| Tool | What it does |
|------|-------------|
| `db_introspect` | Full schema of a PostgreSQL or MySQL database: tables, columns, PKs, FKs, indexes |
| `db_query_analyze` | EXPLAIN ANALYZE with slow-node detection and plain-language suggestions |
| `symfony_routes` | All Symfony routes from `debug:router`, filterable |
| `symfony_services` | All DI services from `debug:container`, filterable |
| `git_blame_context` | Blame + commit history for any file line range |
| `docker_compose_status` | Container state, ports, log tail, and health checks |
| `openapi_validate` | Spec vs. live API drift detection (status codes + response shape) |

## Installation

### Globally (recommended)

```bash
npm install -g mcp-dev-toolkit
```

### Via npx (no install)

```bash
npx mcp-dev-toolkit
```

### From source

```bash
git clone <repo-url>
cd mcp-dev-toolkit
npm install
npm run build
node dist/index.js
```

## Claude Code Integration

Add to your `~/.claude/settings.json` or project `.claude/settings.json`:

```json
{
  "mcpServers": {
    "dev-toolkit": {
      "command": "npx",
      "args": ["-y", "mcp-dev-toolkit"]
    }
  }
}
```

Or if installed globally:

```json
{
  "mcpServers": {
    "dev-toolkit": {
      "command": "mcp-dev-toolkit"
    }
  }
}
```

## Tools Reference

### `db_introspect`

Connects to a PostgreSQL or MySQL database and returns a structured JSON schema.

**Input**

```json
{
  "connection_string": "postgresql://user:password@localhost:5432/mydb",
  "schema": "public"
}
```

- `connection_string` — supports `postgresql://`, `postgres://`, `mysql://`
- `schema` — optional; defaults to `public` (PostgreSQL) or current database (MySQL)

**Output (success)**

```json
{
  "success": true,
  "schema": {
    "driver": "postgres",
    "database": "mydb",
    "schema": "public",
    "introspectedAt": "2024-11-14T20:00:00.000Z",
    "tables": [
      {
        "name": "users",
        "rowEstimate": 12500,
        "columns": [
          { "name": "id", "type": "integer", "nullable": false, "default": "nextval('users_id_seq')", "comment": null },
          { "name": "email", "type": "text", "nullable": false, "default": null, "comment": null }
        ],
        "primaryKey": ["id"],
        "foreignKeys": [],
        "indexes": [
          { "name": "users_email_key", "columns": ["email"], "unique": true, "type": "BTREE" }
        ]
      }
    ]
  }
}
```

---

### `db_query_analyze`

Runs `EXPLAIN ANALYZE` on a SQL query (inside a rolled-back transaction — safe for any environment).

**Input**

```json
{
  "connection_string": "postgresql://user:password@localhost:5432/mydb",
  "sql": "SELECT u.id, u.email, count(o.id) FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id"
}
```

**Output (success)**

```json
{
  "success": true,
  "totalPlanningTimeMs": 0.15,
  "totalExecutionTimeMs": 42.3,
  "planSummary": {
    "nodeType": "HashAggregate",
    "actualTimeMs": 41.8,
    "estimatedRows": 100,
    "actualRows": 12500,
    "isSlow": true,
    "children": [...]
  },
  "slowNodes": [
    {
      "nodeType": "Seq Scan",
      "totalTimeMs": 38.1,
      "detail": { "Relation Name": "orders" },
      "isSlow": true
    }
  ],
  "indexesUsed": [],
  "sequentialScans": ["orders"],
  "suggestions": [
    "Sequential scans detected on: orders. Consider adding indexes on frequently filtered columns.",
    "Row count mismatch in 'HashAggregate': estimated 100, got 12500. Run ANALYZE to refresh table statistics."
  ]
}
```

---

### `symfony_routes`

Lists all routes in a Symfony project.

**Input**

```json
{
  "project_path": "/var/www/my-symfony-app",
  "filter": "api"
}
```

- `project_path` — absolute path to the Symfony project root (must contain `bin/console`)
- `filter` — optional; case-insensitive substring match on route name or path

**Output (success)**

```json
{
  "success": true,
  "projectPath": "/var/www/my-symfony-app",
  "phpVersion": "8.3.6",
  "totalRoutes": 24,
  "routes": [
    {
      "name": "api_users_list",
      "path": "/api/users",
      "methods": ["GET"],
      "controller": "App\\Controller\\Api\\UserController::list",
      "defaults": { "_controller": "App\\Controller\\Api\\UserController::list" },
      "requirements": {},
      "schemes": ["https"],
      "host": ""
    }
  ]
}
```

**Error (not a Symfony project)**

```json
{
  "error": "Not a Symfony project: 'bin/console' not found at /path/to/project",
  "details": { "checked": "/path/to/project/bin/console" }
}
```

---

### `symfony_services`

Lists Symfony DI container services.

**Input**

```json
{
  "project_path": "/var/www/my-symfony-app",
  "filter": "mailer"
}
```

**Output (success)**

```json
{
  "success": true,
  "projectPath": "/var/www/my-symfony-app",
  "phpVersion": "8.3.6",
  "totalServices": 3,
  "services": [
    {
      "id": "Symfony\\Component\\Mailer\\MailerInterface",
      "class": "Symfony\\Component\\Mailer\\Mailer",
      "public": false,
      "abstract": false,
      "synthetic": false,
      "lazy": false,
      "shared": true,
      "tags": [{ "name": "container.service_locator_aware", "attributes": {} }],
      "aliases": ["mailer"],
      "decorates": null
    }
  ]
}
```

---

### `git_blame_context`

Returns blame information and commit details for a file line range.

**Input**

```json
{
  "file_path": "/var/www/my-app/src/Service/UserService.php",
  "start_line": 42,
  "end_line": 58
}
```

**Output (success)**

```json
{
  "success": true,
  "filePath": "/var/www/my-app/src/Service/UserService.php",
  "startLine": 42,
  "endLine": 58,
  "repoRoot": "/var/www/my-app",
  "lines": [
    {
      "lineNumber": 42,
      "content": "    public function findByEmail(string $email): ?User",
      "commit": {
        "hash": "abc1234567890abcdef1234567890abcdef12345",
        "shortHash": "abc12345",
        "author": "Alice Smith",
        "email": "alice@example.com",
        "date": "2024-03-15T10:30:00+01:00",
        "summary": "Add findByEmail method",
        "body": "Needed for authentication flow. Closes #142."
      }
    }
  ],
  "uniqueCommits": [
    {
      "hash": "abc1234567890abcdef1234567890abcdef12345",
      "shortHash": "abc12345",
      "author": "Alice Smith",
      "email": "alice@example.com",
      "date": "2024-03-15T10:30:00+01:00",
      "summary": "Add findByEmail method",
      "body": "Needed for authentication flow. Closes #142."
    }
  ]
}
```

---

### `docker_compose_status`

Returns status, ports, logs, and health for Docker Compose services.

**Input**

```json
{
  "compose_file": "/var/www/my-app/docker-compose.yml",
  "service": "web"
}
```

- `compose_file` — absolute path to the compose file
- `service` — optional; restrict to a single service

**Output (success)**

```json
{
  "success": true,
  "composeFile": "/var/www/my-app/docker-compose.yml",
  "projectName": "my-app",
  "checkedAt": "2024-11-14T20:00:00.000Z",
  "services": [
    {
      "name": "web",
      "containerId": "abc123def456",
      "image": "nginx:alpine",
      "status": "running",
      "state": "Up 2 hours",
      "ports": [
        { "hostIp": "0.0.0.0", "hostPort": "8080", "containerPort": "80", "protocol": "tcp" }
      ],
      "health": {
        "status": "healthy",
        "failingStreak": 0,
        "lastOutput": ""
      },
      "logTail": [
        "2024-11-14T19:58:01Z web  | 172.18.0.1 - - [14/Nov/2024:19:58:01 +0000] \"GET /health HTTP/1.1\" 200 2"
      ]
    }
  ]
}
```

---

### `openapi_validate`

Loads an OpenAPI spec and validates sampled endpoints against a running API.

**Input**

```json
{
  "spec_path": "/var/www/my-app/openapi.json",
  "base_url": "http://localhost:8000",
  "sample_count": 10
}
```

- `spec_path` — path to a JSON/YAML spec file, or a URL (`http://...`) to fetch the spec
- `base_url` — running API base URL to validate against
- `sample_count` — max endpoints to test (default 10; max 50)

**Output (success)**

```json
{
  "success": true,
  "specSource": "/var/www/my-app/openapi.json",
  "baseUrl": "http://localhost:8000",
  "apiTitle": "My API",
  "apiVersion": "2.1.0",
  "totalEndpoints": 42,
  "sampledEndpoints": 10,
  "summary": {
    "passed": 8,
    "failed": 1,
    "errored": 1,
    "driftDetected": true
  },
  "validations": [
    {
      "method": "GET",
      "path": "/users",
      "operationId": "listUsers",
      "requestUrl": "http://localhost:8000/users",
      "expectedStatuses": [200],
      "actualStatus": 200,
      "statusMatch": true,
      "responseBodyValid": true,
      "responseTimeMs": 23,
      "driftReasons": [],
      "error": null
    },
    {
      "method": "GET",
      "path": "/products/{id}",
      "operationId": "getProduct",
      "requestUrl": "http://localhost:8000/products/1",
      "expectedStatuses": [200, 404],
      "actualStatus": 500,
      "statusMatch": false,
      "responseBodyValid": null,
      "responseTimeMs": 2100,
      "driftReasons": ["Expected status [200, 404], got 500"],
      "error": null
    }
  ]
}
```

## Security

- **No shell injection** — all shell commands use `spawn(cmd, argsArray)` — never string interpolation
- **Credentials never logged** — connection strings are sanitized before appearing in any error message
- **Read-only DB analysis** — `db_query_analyze` wraps EXPLAIN ANALYZE in a transaction that is always rolled back
- **Safe API probing** — `openapi_validate` only makes GET requests by default; endpoints with required request bodies are skipped

## Peer Dependencies

`pg` and `mysql2` are optional — install only what you need:

```bash
npm install pg          # for PostgreSQL support
npm install mysql2      # for MySQL support
```

## Docker

```bash
docker build -t mcp-dev-toolkit .

# Run with access to host docker socket and a codebase
docker run -i \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /var/www/my-app:/workspace:ro \
  mcp-dev-toolkit
```

## Development

```bash
npm run build       # compile TypeScript
npm run typecheck   # type-check without emitting
npm run lint        # Biome lint + format check
npm run lint:fix    # Biome auto-fix
npm test            # Vitest unit tests
npm run test:coverage  # with coverage report (target: 80%)
```

## License

MIT
