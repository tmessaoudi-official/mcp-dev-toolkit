/**
 * Integration test: db_introspect with a real PostgreSQL instance.
 *
 * These tests require a running PostgreSQL server. Set the env var:
 *   TEST_POSTGRES_DSN=postgresql://user:pass@localhost:5432/testdb
 *
 * If not set, all integration tests are skipped.
 *
 * In CI, use a service container:
 *   services:
 *     postgres:
 *       image: postgres:16
 *       env: { POSTGRES_PASSWORD: test, POSTGRES_DB: testdb }
 *
 * Then set: TEST_POSTGRES_DSN=postgresql://postgres:test@localhost:5432/testdb
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbIntrospect } from '../../src/tools/db-introspect.js';
import { createConnection } from '../../src/utils/db-connection.js';

const DSN = process.env['TEST_POSTGRES_DSN'];

const describeIntegration = DSN ? describe : describe.skip;

describeIntegration('db_introspect (integration — real PostgreSQL)', () => {
  let db: Awaited<ReturnType<typeof createConnection>>;

  beforeAll(async () => {
    // Create test schema and table
    db = await createConnection(DSN!);
    await db.query(`
      CREATE TABLE IF NOT EXISTS mcp_test_users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS mcp_test_posts (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES mcp_test_users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        body TEXT
      )
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS mcp_test_posts_user_idx ON mcp_test_posts(user_id)
    `);
  });

  afterAll(async () => {
    await db.query('DROP TABLE IF EXISTS mcp_test_posts');
    await db.query('DROP TABLE IF EXISTS mcp_test_users');
    await db.close();
  });

  it('successfully introspects the public schema', async () => {
    const result = await dbIntrospect({ connection_string: DSN!, schema: 'public' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      schema: { driver: string; tables: { name: string }[] };
    };
    expect(success.success).toBe(true);
    expect(success.schema.driver).toBe('postgres');
  });

  it('finds the test tables', async () => {
    const result = await dbIntrospect({ connection_string: DSN! });
    const success = result as { success: true; schema: { tables: { name: string }[] } };
    const tableNames = success.schema.tables.map((t) => t.name);

    expect(tableNames).toContain('mcp_test_users');
    expect(tableNames).toContain('mcp_test_posts');
  });

  it('returns column details for mcp_test_users', async () => {
    const result = await dbIntrospect({ connection_string: DSN! });
    const success = result as {
      success: true;
      schema: {
        tables: {
          name: string;
          columns: { name: string; type: string; nullable: boolean }[];
          primaryKey: string[];
          indexes: { name: string; unique: boolean }[];
        }[];
      };
    };

    const usersTable = success.schema.tables.find((t) => t.name === 'mcp_test_users');
    expect(usersTable).toBeDefined();
    expect(usersTable!.primaryKey).toEqual(['id']);

    const emailCol = usersTable!.columns.find((c) => c.name === 'email');
    expect(emailCol).toBeDefined();
    expect(emailCol!.nullable).toBe(false);

    const emailIdx = usersTable!.indexes.find((i) => i.name.includes('email'));
    expect(emailIdx?.unique).toBe(true);
  });

  it('detects foreign key between posts and users', async () => {
    const result = await dbIntrospect({ connection_string: DSN! });
    const success = result as {
      success: true;
      schema: {
        tables: {
          name: string;
          foreignKeys: { referencedTable: string; onDelete: string }[];
        }[];
      };
    };

    const postsTable = success.schema.tables.find((t) => t.name === 'mcp_test_posts');
    expect(postsTable).toBeDefined();
    expect(postsTable!.foreignKeys).toHaveLength(1);
    expect(postsTable!.foreignKeys[0]?.referencedTable).toBe('mcp_test_users');
    expect(postsTable!.foreignKeys[0]?.onDelete).toBe('CASCADE');
  });
});
