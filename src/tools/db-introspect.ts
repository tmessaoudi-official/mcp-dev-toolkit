/**
 * db_introspect — Returns structured JSON schema for a PostgreSQL or MySQL database.
 * Includes: tables, columns (name, type, nullable, default), primary keys, foreign keys, indexes.
 */

import { z } from 'zod';
import { createConnection, sanitizeConnectionString } from '../utils/db-connection.js';

export const DbIntrospectInput = z.object({
  connection_string: z
    .string()
    .min(1)
    .describe('Database connection string. Supports postgresql://, postgres://, mysql://'),
  schema: z
    .string()
    .optional()
    .describe('Schema name to inspect (default: public for PostgreSQL, current DB for MySQL)'),
});

export type DbIntrospectInput = z.infer<typeof DbIntrospectInput>;

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ForeignKeyInfo {
  constraintName: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
  onDelete: string;
  onUpdate: string;
}

export interface TableSchema {
  name: string;
  columns: ColumnInfo[];
  primaryKey: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
  rowEstimate: number | null;
}

export interface DbSchema {
  driver: string;
  database: string;
  schema: string;
  tables: TableSchema[];
  introspectedAt: string;
}

export interface DbIntrospectResult {
  success: true;
  schema: DbSchema;
}

export interface DbIntrospectError {
  error: string;
  details?: { connection: string; driver?: string };
}

export async function dbIntrospect(
  input: DbIntrospectInput,
): Promise<DbIntrospectResult | DbIntrospectError> {
  const db = await createConnection(input.connection_string).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `Failed to connect to database: ${message}`,
      details: { connection: sanitizeConnectionString(input.connection_string) },
    } satisfies DbIntrospectError;
  });

  if ('error' in db) return db;

  try {
    const isPostgres = input.connection_string.toLowerCase().startsWith('post');
    const schema = input.schema ?? (isPostgres ? 'public' : '');

    if (isPostgres) {
      return await introspectPostgres(
        db as Awaited<ReturnType<typeof createConnection>>,
        schema,
        input.connection_string,
      );
    }
    return await introspectMysql(
      db as Awaited<ReturnType<typeof createConnection>>,
      schema,
      input.connection_string,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `Introspection failed: ${message}`,
      details: { connection: sanitizeConnectionString(input.connection_string) },
    };
  } finally {
    await db.close().catch(() => {});
  }
}

import type { DbConnection } from '../utils/db-connection.js';

async function introspectPostgres(
  db: DbConnection,
  schema: string,
  _connStr: string,
): Promise<DbIntrospectResult> {
  // Get database name
  const dbNameResult = await db.query('SELECT current_database() AS db');
  const databaseName = String((dbNameResult.rows[0] as { db?: unknown })?.db ?? 'unknown');

  // Get all tables in schema
  const tablesResult = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );

  const tables: TableSchema[] = await Promise.all(
    tablesResult.rows.map((row) =>
      introspectPostgresTable(db, schema, String((row as { tablename?: unknown }).tablename)),
    ),
  );

  return {
    success: true,
    schema: {
      driver: 'postgres',
      database: databaseName,
      schema,
      tables,
      introspectedAt: new Date().toISOString(),
    },
  };
}

interface PgColumnRow {
  column_name?: unknown;
  data_type?: unknown;
  udt_name?: unknown;
  is_nullable?: unknown;
  column_default?: unknown;
  comment?: unknown;
}

interface PgPkRow {
  column_name?: unknown;
}

interface PgFkRow {
  constraint_name?: unknown;
  column_name?: unknown;
  referenced_table?: unknown;
  referenced_column?: unknown;
  on_delete?: unknown;
  on_update?: unknown;
}

interface PgIdxRow {
  index_name?: unknown;
  is_unique?: unknown;
  index_type?: unknown;
  columns?: unknown;
}

interface PgEstRow {
  estimate?: unknown;
}

async function introspectPostgresTable(
  db: DbConnection,
  schema: string,
  table: string,
): Promise<TableSchema> {
  // Columns
  const colResult = await db.query(
    `SELECT
       c.column_name,
       c.data_type,
       c.udt_name,
       c.is_nullable,
       c.column_default,
       pgd.description AS comment
     FROM information_schema.columns c
     LEFT JOIN pg_catalog.pg_statio_all_tables st ON st.relname = c.table_name AND st.schemaname = c.table_schema
     LEFT JOIN pg_catalog.pg_description pgd ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
     WHERE c.table_schema = $1 AND c.table_name = $2
     ORDER BY c.ordinal_position`,
    [schema, table],
  );

  const columns: ColumnInfo[] = colResult.rows.map((rawR) => {
    const r = rawR as PgColumnRow;
    return {
      name: String(r.column_name),
      type: r.data_type === 'USER-DEFINED' ? String(r.udt_name) : String(r.data_type),
      nullable: r.is_nullable === 'YES',
      default: r.column_default != null ? String(r.column_default) : null,
      comment: r.comment != null ? String(r.comment) : null,
    };
  });

  // Primary key
  const pkResult = await db.query(
    `SELECT a.attname AS column_name
     FROM pg_index i
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.indisprimary AND c.relname = $1 AND n.nspname = $2
     ORDER BY a.attnum`,
    [table, schema],
  );
  const primaryKey = pkResult.rows.map((r) => String((r as PgPkRow).column_name));

  // Foreign keys
  const fkResult = await db.query(
    `SELECT
       tc.constraint_name,
       kcu.column_name,
       ccu.table_name AS referenced_table,
       ccu.column_name AS referenced_column,
       rc.delete_rule AS on_delete,
       rc.update_rule AS on_update
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
     JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
     WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`,
    [table, schema],
  );
  const foreignKeys: ForeignKeyInfo[] = fkResult.rows.map((rawR) => {
    const r = rawR as PgFkRow;
    return {
      constraintName: String(r.constraint_name),
      column: String(r.column_name),
      referencedTable: String(r.referenced_table),
      referencedColumn: String(r.referenced_column),
      onDelete: String(r.on_delete),
      onUpdate: String(r.on_update),
    };
  });

  // Indexes
  const idxResult = await db.query(
    `SELECT
       i.relname AS index_name,
       ix.indisunique AS is_unique,
       am.amname AS index_type,
       ARRAY_AGG(a.attname ORDER BY a.attnum) AS columns
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_am am ON am.oid = i.relam
     JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE t.relname = $1 AND n.nspname = $2
     GROUP BY i.relname, ix.indisunique, am.amname`,
    [table, schema],
  );
  const indexes: IndexInfo[] = idxResult.rows.map((rawR) => {
    const r = rawR as PgIdxRow;
    return {
      name: String(r.index_name),
      columns: Array.isArray(r.columns) ? r.columns.map(String) : [],
      unique: Boolean(r.is_unique),
      type: String(r.index_type).toUpperCase(),
    };
  });

  // Row estimate from pg_class
  const estResult = await db.query(
    `SELECT reltuples::bigint AS estimate
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1 AND n.nspname = $2`,
    [table, schema],
  );
  const estRow = estResult.rows[0] as PgEstRow | undefined;
  const rowEstimate = estRow?.estimate != null ? Number(estRow.estimate) : null;

  return { name: table, columns, primaryKey, foreignKeys, indexes, rowEstimate };
}

async function introspectMysql(
  db: DbConnection,
  schemaHint: string,
  _connStr: string,
): Promise<DbIntrospectResult> {
  const dbNameResult = await db.query('SELECT DATABASE() AS db');
  const databaseName = String((dbNameResult.rows[0] as { db?: unknown })?.db ?? 'unknown');
  const schema = schemaHint || databaseName;

  const tablesResult = await db.query(
    `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    [schema],
  );

  const tables: TableSchema[] = await Promise.all(
    tablesResult.rows.map((row) =>
      introspectMysqlTable(db, schema, String((row as { TABLE_NAME?: unknown }).TABLE_NAME)),
    ),
  );

  return {
    success: true,
    schema: {
      driver: 'mysql',
      database: databaseName,
      schema,
      tables,
      introspectedAt: new Date().toISOString(),
    },
  };
}

interface MysqlColumnRow {
  COLUMN_NAME?: unknown;
  COLUMN_TYPE?: unknown;
  IS_NULLABLE?: unknown;
  COLUMN_DEFAULT?: unknown;
  COLUMN_COMMENT?: unknown;
}

interface MysqlFkRow {
  CONSTRAINT_NAME?: unknown;
  COLUMN_NAME?: unknown;
  REFERENCED_TABLE_NAME?: unknown;
  REFERENCED_COLUMN_NAME?: unknown;
}

interface MysqlRcRow {
  DELETE_RULE?: unknown;
  UPDATE_RULE?: unknown;
}

interface MysqlIdxRow {
  INDEX_NAME?: unknown;
  NON_UNIQUE?: unknown;
  INDEX_TYPE?: unknown;
  cols?: unknown;
}

interface MysqlEstRow {
  TABLE_ROWS?: unknown;
}

async function introspectMysqlTable(
  db: DbConnection,
  schema: string,
  table: string,
): Promise<TableSchema> {
  const colResult = await db.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
  );

  const columns: ColumnInfo[] = colResult.rows.map((rawR) => {
    const r = rawR as MysqlColumnRow;
    return {
      name: String(r.COLUMN_NAME),
      type: String(r.COLUMN_TYPE),
      nullable: r.IS_NULLABLE === 'YES',
      default: r.COLUMN_DEFAULT != null ? String(r.COLUMN_DEFAULT) : null,
      comment: r.COLUMN_COMMENT ? String(r.COLUMN_COMMENT) : null,
    };
  });

  const pkResult = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY'
     ORDER BY ORDINAL_POSITION`,
    [schema, table],
  );
  const primaryKey = pkResult.rows.map((r) => String((r as MysqlColumnRow).COLUMN_NAME));

  const fkResult = await db.query(
    `SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
    [schema, table],
  );

  const fkDetails = await Promise.all(
    fkResult.rows.map(async (rawR) => {
      const r = rawR as MysqlFkRow;
      const rcResult = await db.query(
        `SELECT DELETE_RULE, UPDATE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
       WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ?`,
        [schema, String(r.CONSTRAINT_NAME)],
      );
      const rc = (rcResult.rows[0] as MysqlRcRow | undefined) ?? null;
      return {
        constraintName: String(r.CONSTRAINT_NAME),
        column: String(r.COLUMN_NAME),
        referencedTable: String(r.REFERENCED_TABLE_NAME),
        referencedColumn: String(r.REFERENCED_COLUMN_NAME),
        onDelete: rc ? String(rc.DELETE_RULE) : 'NO ACTION',
        onUpdate: rc ? String(rc.UPDATE_RULE) : 'NO ACTION',
      } satisfies ForeignKeyInfo;
    }),
  );

  const idxResult = await db.query(
    `SELECT INDEX_NAME, NON_UNIQUE, INDEX_TYPE, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     GROUP BY INDEX_NAME, NON_UNIQUE, INDEX_TYPE`,
    [schema, table],
  );
  const indexes: IndexInfo[] = idxResult.rows.map((rawR) => {
    const r = rawR as MysqlIdxRow;
    return {
      name: String(r.INDEX_NAME),
      columns: String(r.cols).split(','),
      unique: r.NON_UNIQUE === 0 || r.NON_UNIQUE === '0',
      type: String(r.INDEX_TYPE),
    };
  });

  const estResult = await db.query(
    `SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [schema, table],
  );
  const estRow = estResult.rows[0] as MysqlEstRow | undefined;
  const rowEstimate = estRow?.TABLE_ROWS != null ? Number(estRow.TABLE_ROWS) : null;

  return { name: table, columns, primaryKey, foreignKeys: fkDetails, indexes, rowEstimate };
}
