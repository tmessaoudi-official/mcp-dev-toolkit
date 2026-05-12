/**
 * Database connection abstraction.
 * Dynamically loads 'pg' or 'mysql2' based on the connection string prefix.
 * Both are optional peer dependencies — loaded lazily.
 *
 * Connection strings are never logged. The sanitize() helper strips credentials.
 */

export type DbDriver = 'postgres' | 'mysql';

export interface QueryResultField {
  name: string;
  dataTypeId?: number | undefined;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields: QueryResultField[];
}

export interface DbConnection {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

/**
 * Returns the driver type from a connection string.
 * Supports: postgresql://, postgres://, mysql://
 */
export function detectDriver(connectionString: string): DbDriver {
  const lower = connectionString.toLowerCase();
  if (lower.startsWith('postgresql://') || lower.startsWith('postgres://')) {
    return 'postgres';
  }
  if (lower.startsWith('mysql://')) {
    return 'mysql';
  }
  throw new Error(
    `Unsupported connection string prefix. Expected 'postgresql://', 'postgres://', or 'mysql://'`,
  );
}

/**
 * Strips credentials from a connection string for safe logging/display.
 */
export function sanitizeConnectionString(cs: string): string {
  try {
    const url = new URL(cs);
    url.password = '****';
    url.username = url.username ? '****' : '';
    return url.toString();
  } catch {
    return '<invalid-connection-string>';
  }
}

/**
 * Creates a database connection using the appropriate driver.
 * Credentials are never stored in logs.
 */
export async function createConnection(connectionString: string): Promise<DbConnection> {
  const driver = detectDriver(connectionString);

  if (driver === 'postgres') {
    return createPostgresConnection(connectionString);
  }
  return createMysqlConnection(connectionString);
}

interface PgQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  fields: Array<{ name: string; dataTypeID: number }>;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<PgQueryResult>;
  end(): Promise<void>;
}

interface PgModule {
  Client: new (config: { connectionString: string }) => PgClient;
}

async function createPostgresConnection(connectionString: string): Promise<DbConnection> {
  let pgModule: PgModule;
  try {
    const imported = (await import('pg')) as unknown;
    pgModule = imported as PgModule;
  } catch {
    throw new Error("PostgreSQL peer dependency 'pg' is not installed. Run: npm install pg");
  }

  const client = new pgModule.Client({ connectionString });
  await client.connect();

  return {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const result = await client.query(sql, params);
      return {
        rows: result.rows,
        rowCount: result.rowCount ?? 0,
        fields: result.fields.map((f) => ({ name: f.name, dataTypeId: f.dataTypeID })),
      };
    },
    async close(): Promise<void> {
      await client.end();
    },
  };
}

interface MysqlRow {
  [key: string]: unknown;
}

interface MysqlField {
  name: string;
  columnType?: number | undefined;
}

interface MysqlConnection {
  execute(sql: string, params?: unknown[]): Promise<[MysqlRow[], MysqlField[]]>;
  end(): Promise<void>;
}

interface MysqlModule {
  createConnection(config: { uri: string; multipleStatements: boolean }): Promise<MysqlConnection>;
}

async function createMysqlConnection(connectionString: string): Promise<DbConnection> {
  let mysqlModule: MysqlModule;
  try {
    const imported = (await import('mysql2/promise')) as unknown;
    mysqlModule = imported as MysqlModule;
  } catch {
    throw new Error("MySQL peer dependency 'mysql2' is not installed. Run: npm install mysql2");
  }

  const conn = await mysqlModule.createConnection({
    uri: connectionString,
    multipleStatements: false,
  });

  return {
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const [rows, fields] = await conn.execute(sql, params ?? []);
      const rowArray = Array.isArray(rows) ? (rows as MysqlRow[]) : [];
      return {
        rows: rowArray,
        rowCount: rowArray.length,
        fields: (fields ?? []).map((f: MysqlField) => {
          const field: QueryResultField = { name: f.name };
          if (f.columnType !== undefined) field.dataTypeId = f.columnType;
          return field;
        }),
      };
    },
    async close(): Promise<void> {
      await conn.end();
    },
  };
}
