import { describe, expect, it, vi } from 'vitest';
import { detectDriver, sanitizeConnectionString } from '../../src/utils/db-connection.js';

describe('db-connection utils', () => {
  describe('detectDriver()', () => {
    it('detects postgres from postgresql:// prefix', () => {
      expect(detectDriver('postgresql://user:pass@localhost/db')).toBe('postgres');
    });

    it('detects postgres from postgres:// prefix', () => {
      expect(detectDriver('postgres://user:pass@localhost/db')).toBe('postgres');
    });

    it('detects mysql from mysql:// prefix', () => {
      expect(detectDriver('mysql://user:pass@localhost/db')).toBe('mysql');
    });

    it('throws on unsupported prefix', () => {
      expect(() => detectDriver('mongodb://localhost/db')).toThrow('Unsupported connection string');
    });

    it('throws on empty string', () => {
      expect(() => detectDriver('')).toThrow();
    });

    it('is case-insensitive for detection', () => {
      expect(detectDriver('PostgreSQL://user@localhost/db')).toBe('postgres');
      expect(detectDriver('MYSQL://user@localhost/db')).toBe('mysql');
    });
  });

  describe('sanitizeConnectionString()', () => {
    it('masks password in connection string', () => {
      const sanitized = sanitizeConnectionString(
        'postgresql://user:supersecret@localhost:5432/mydb',
      );
      expect(sanitized).not.toContain('supersecret');
      expect(sanitized).toContain('****');
    });

    it('handles connection strings without password', () => {
      const sanitized = sanitizeConnectionString('postgresql://localhost/mydb');
      expect(sanitized).not.toContain('undefined');
      expect(sanitized).toBeTruthy();
    });

    it('returns safe placeholder for invalid URLs', () => {
      const sanitized = sanitizeConnectionString('not-a-valid-url');
      expect(sanitized).toBe('<invalid-connection-string>');
    });

    it('masks username as well', () => {
      const sanitized = sanitizeConnectionString('postgresql://adminuser:pass@localhost/db');
      expect(sanitized).not.toContain('adminuser');
    });

    it('preserves host and database in sanitized output', () => {
      const sanitized = sanitizeConnectionString('postgresql://user:pass@myhost:5432/mydb');
      expect(sanitized).toContain('myhost');
      expect(sanitized).toContain('5432');
    });
  });

  describe('createConnection()', () => {
    it('throws if pg module is not installed for postgres connections', async () => {
      // Mock dynamic import to throw — simulates missing peer dep
      vi.doMock('pg', () => {
        throw new Error('Cannot find module pg');
      });

      // Re-import createConnection after mocking
      const { createConnection } = await import('../../src/utils/db-connection.js');

      // The function should propagate the error as "peer dep not installed"
      await expect(createConnection('postgresql://u:p@localhost/db')).rejects.toThrow();

      vi.doUnmock('pg');
    });

    it('creates a working postgres connection object when pg is available', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined);
      const mockQuery = vi.fn().mockResolvedValue({
        rows: [{ result: 1 }],
        rowCount: 1,
        fields: [{ name: 'result', dataTypeID: 23 }],
      });
      const mockConnect = vi.fn().mockResolvedValue(undefined);

      // Must use a class constructor for pg.Client (used with `new`)
      class MockClient {
        connect = mockConnect;
        query = mockQuery;
        end = mockEnd;
      }

      vi.doMock('pg', () => ({
        Client: MockClient,
        default: { Client: MockClient },
      }));

      const { createConnection } = await import('../../src/utils/db-connection.js');

      const conn = await createConnection('postgresql://u:p@localhost/testdb');
      expect(mockConnect).toHaveBeenCalled();

      const result = await conn.query('SELECT 1');
      expect(result.rows).toEqual([{ result: 1 }]);
      expect(result.fields[0]?.name).toBe('result');
      expect(result.fields[0]?.dataTypeId).toBe(23);

      await conn.close();
      expect(mockEnd).toHaveBeenCalled();

      vi.doUnmock('pg');
    });

    it('creates a working mysql connection object when mysql2 is available', async () => {
      const mockEnd = vi.fn().mockResolvedValue(undefined);
      const mockExecute = vi.fn().mockResolvedValue([[{ id: 1 }], [{ name: 'id', columnType: 3 }]]);
      const mockCreateConnection = vi.fn().mockResolvedValue({
        execute: mockExecute,
        end: mockEnd,
      });

      vi.doMock('mysql2/promise', () => ({
        default: { createConnection: mockCreateConnection },
        createConnection: mockCreateConnection,
      }));

      const { createConnection } = await import('../../src/utils/db-connection.js');

      const conn = await createConnection('mysql://u:p@localhost/testdb');
      expect(mockCreateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'mysql://u:p@localhost/testdb' }),
      );

      const result = await conn.query('SELECT 1');
      expect(result.rows).toEqual([{ id: 1 }]);
      expect(result.fields[0]?.dataTypeId).toBe(3);

      await conn.close();
      expect(mockEnd).toHaveBeenCalled();

      vi.doUnmock('mysql2/promise');
    });
  });
});
