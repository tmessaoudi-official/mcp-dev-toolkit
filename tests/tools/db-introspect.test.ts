import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the db-connection module before importing db-introspect
vi.mock('../../src/utils/db-connection.js', () => ({
  createConnection: vi.fn(),
  sanitizeConnectionString: vi.fn((cs: string) => cs.replace(/:\/\/[^@]+@/, '://****@')),
  detectDriver: vi.fn(),
}));

import { dbIntrospect } from '../../src/tools/db-introspect.js';
import { createConnection } from '../../src/utils/db-connection.js';

const mockCreateConnection = vi.mocked(createConnection);

function makeQueryMock(
  responses: Record<string, { rows: Record<string, unknown>[]; rowCount: number; fields: [] }>,
) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      for (const [key, value] of Object.entries(responses)) {
        if (sql.includes(key)) return Promise.resolve(value);
      }
      return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
    }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('dbIntrospect()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an error when connection fails', async () => {
    mockCreateConnection.mockRejectedValue(new Error('Connection refused'));

    const result = await dbIntrospect({
      connection_string: 'postgresql://user:pass@localhost/db',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Failed to connect');
  });

  it('returns schema with tables for a postgres connection', async () => {
    const mockDb = makeQueryMock({
      current_database: { rows: [{ db: 'testdb' }], rowCount: 1, fields: [] },
      pg_tables: { rows: [{ tablename: 'users' }], rowCount: 1, fields: [] },
      'information_schema.columns': {
        rows: [
          {
            column_name: 'id',
            data_type: 'integer',
            is_nullable: 'NO',
            column_default: null,
            comment: null,
          },
        ],
        rowCount: 1,
        fields: [],
      },
      indisprimary: { rows: [{ column_name: 'id' }], rowCount: 1, fields: [] },
      'FOREIGN KEY': { rows: [], rowCount: 0, fields: [] },
      pg_class: { rows: [{ estimate: 100 }], rowCount: 1, fields: [] },
      pg_index: { rows: [], rowCount: 0, fields: [] },
    });

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({
      connection_string: 'postgresql://user:pass@localhost/testdb',
      schema: 'public',
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      schema: { driver: string; database: string; tables: unknown[] };
    };
    expect(success.success).toBe(true);
    expect(success.schema.driver).toBe('postgres');
    expect(success.schema.database).toBe('testdb');
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('closes connection even when introspection fails', async () => {
    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ db: 'testdb' }], rowCount: 1, fields: [] })
        .mockRejectedValueOnce(new Error('Query error')),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({
      connection_string: 'postgresql://user:pass@localhost/db',
    });

    expect(result).toHaveProperty('error');
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('uses default schema public for postgres', async () => {
    const mockDb = makeQueryMock({
      current_database: { rows: [{ db: 'mydb' }], rowCount: 1, fields: [] },
      pg_tables: { rows: [], rowCount: 0, fields: [] },
    });

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({ connection_string: 'postgresql://u:p@h/mydb' });

    const success = result as { success: true; schema: { schema: string } };
    expect(success.schema?.schema).toBe('public');
  });

  it('returns schema with tables for a mysql connection', async () => {
    // MySQL introspect runs multiple queries sequentially — mock them in order
    const mockDb = {
      query: vi
        .fn()
        // SELECT DATABASE() AS db
        .mockResolvedValueOnce({ rows: [{ db: 'mysqldb' }], rowCount: 1, fields: [] })
        // SELECT TABLE_NAME FROM information_schema.TABLES (list tables)
        .mockResolvedValueOnce({ rows: [{ TABLE_NAME: 'orders' }], rowCount: 1, fields: [] })
        // SELECT COLUMN_NAME... FROM information_schema.COLUMNS
        .mockResolvedValueOnce({
          rows: [
            {
              COLUMN_NAME: 'id',
              COLUMN_TYPE: 'int',
              IS_NULLABLE: 'NO',
              COLUMN_DEFAULT: null,
              COLUMN_COMMENT: '',
            },
          ],
          rowCount: 1,
          fields: [],
        })
        // SELECT COLUMN_NAME FROM KEY_COLUMN_USAGE WHERE CONSTRAINT_NAME = 'PRIMARY'
        .mockResolvedValueOnce({ rows: [{ COLUMN_NAME: 'id' }], rowCount: 1, fields: [] })
        // SELECT CONSTRAINT_NAME... FROM KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_NAME IS NOT NULL
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        // SELECT INDEX_NAME... FROM information_schema.STATISTICS
        .mockResolvedValueOnce({
          rows: [{ INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, INDEX_TYPE: 'BTREE', cols: 'id' }],
          rowCount: 1,
          fields: [],
        })
        // SELECT TABLE_ROWS FROM information_schema.TABLES (row estimate)
        .mockResolvedValueOnce({ rows: [{ TABLE_ROWS: 42 }], rowCount: 1, fields: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({ connection_string: 'mysql://u:p@localhost/mysqldb' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      schema: {
        driver: string;
        tables: {
          name: string;
          columns: { name: string }[];
          primaryKey: string[];
          indexes: { name: string; unique: boolean }[];
          rowEstimate: number | null;
        }[];
      };
    };
    expect(success.schema.driver).toBe('mysql');
    expect(success.schema.tables[0]?.name).toBe('orders');
    expect(success.schema.tables[0]?.primaryKey).toEqual(['id']);
    expect(success.schema.tables[0]?.indexes[0]?.name).toBe('PRIMARY');
    expect(success.schema.tables[0]?.indexes[0]?.unique).toBe(true);
    expect(success.schema.tables[0]?.rowEstimate).toBe(42);
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('handles mysql table with foreign keys', async () => {
    const mockDb = {
      query: vi
        .fn()
        // SELECT DATABASE()
        .mockResolvedValueOnce({ rows: [{ db: 'testdb' }], rowCount: 1, fields: [] })
        // TABLE list
        .mockResolvedValueOnce({ rows: [{ TABLE_NAME: 'posts' }], rowCount: 1, fields: [] })
        // COLUMNS
        .mockResolvedValueOnce({
          rows: [
            {
              COLUMN_NAME: 'user_id',
              COLUMN_TYPE: 'int',
              IS_NULLABLE: 'YES',
              COLUMN_DEFAULT: null,
              COLUMN_COMMENT: '',
            },
          ],
          rowCount: 1,
          fields: [],
        })
        // PRIMARY KEY
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        // FK from KEY_COLUMN_USAGE
        .mockResolvedValueOnce({
          rows: [
            {
              CONSTRAINT_NAME: 'fk_user',
              COLUMN_NAME: 'user_id',
              REFERENCED_TABLE_NAME: 'users',
              REFERENCED_COLUMN_NAME: 'id',
            },
          ],
          rowCount: 1,
          fields: [],
        })
        // REFERENTIAL_CONSTRAINTS for fk_user
        .mockResolvedValueOnce({
          rows: [{ DELETE_RULE: 'CASCADE', UPDATE_RULE: 'NO ACTION' }],
          rowCount: 1,
          fields: [],
        })
        // STATISTICS
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] })
        // TABLE_ROWS estimate
        .mockResolvedValueOnce({ rows: [{ TABLE_ROWS: 100 }], rowCount: 1, fields: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({ connection_string: 'mysql://u:p@localhost/testdb' });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      schema: { tables: { foreignKeys: { constraintName: string; onDelete: string }[] }[] };
    };
    expect(success.schema.tables[0]?.foreignKeys[0]?.constraintName).toBe('fk_user');
    expect(success.schema.tables[0]?.foreignKeys[0]?.onDelete).toBe('CASCADE');
  });

  it('handles postgres column with USER-DEFINED type', async () => {
    const mockDb = makeQueryMock({
      current_database: { rows: [{ db: 'testdb' }], rowCount: 1, fields: [] },
      pg_tables: { rows: [{ tablename: 'events' }], rowCount: 1, fields: [] },
      'information_schema.columns': {
        rows: [
          {
            column_name: 'status',
            data_type: 'USER-DEFINED',
            udt_name: 'event_status',
            is_nullable: 'YES',
            column_default: null,
            comment: 'The event status',
          },
        ],
        rowCount: 1,
        fields: [],
      },
      indisprimary: { rows: [], rowCount: 0, fields: [] },
      'FOREIGN KEY': { rows: [], rowCount: 0, fields: [] },
      pg_class: { rows: [{ estimate: 50 }], rowCount: 1, fields: [] },
      pg_index: { rows: [], rowCount: 0, fields: [] },
    });

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbIntrospect({
      connection_string: 'postgresql://u:p@h/testdb',
      schema: 'public',
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      schema: { tables: { columns: { type: string; comment: string | null }[] }[] };
    };
    // USER-DEFINED type should use udt_name
    expect(success.schema.tables[0]?.columns[0]?.type).toBe('event_status');
    expect(success.schema.tables[0]?.columns[0]?.comment).toBe('The event status');
  });
});
