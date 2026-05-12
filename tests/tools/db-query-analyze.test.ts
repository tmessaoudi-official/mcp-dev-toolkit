import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/db-connection.js', () => ({
  createConnection: vi.fn(),
  sanitizeConnectionString: vi.fn((cs: string) => cs.replace(/:\/\/[^@]+@/, '://****@')),
  detectDriver: vi.fn(),
}));

import { dbQueryAnalyze } from '../../src/tools/db-query-analyze.js';
import { createConnection } from '../../src/utils/db-connection.js';

const mockCreateConnection = vi.mocked(createConnection);

const samplePgPlan = [
  {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      Alias: 'users',
      'Startup Cost': 0.0,
      'Total Cost': 24.0,
      'Plan Rows': 100,
      'Plan Width': 36,
      'Actual Startup Time': 0.05,
      'Actual Total Time': 1.2,
      'Actual Rows': 1000,
      'Actual Loops': 1,
      Plans: [],
    },
    'Planning Time': 0.15,
    'Execution Time': 1.4,
  },
];

describe('dbQueryAnalyze()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when connection fails', async () => {
    mockCreateConnection.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT 1',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Failed to connect');
  });

  it('returns analysis result for a postgres plan', async () => {
    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ 'QUERY PLAN': samplePgPlan }],
          rowCount: 1,
          fields: [],
        }) // EXPLAIN ANALYZE
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }), // ROLLBACK
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT * FROM users',
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      totalExecutionTimeMs: number;
      sequentialScans: string[];
      suggestions: string[];
    };
    expect(success.success).toBe(true);
    expect(success.totalExecutionTimeMs).toBe(1.4);
    expect(success.sequentialScans).toContain('users');
    // Row count mismatch (estimated 100, actual 1000) should generate a suggestion
    expect(
      success.suggestions.some((s) => s.includes('Sequential scans') || s.includes('Row')),
    ).toBe(true);
  });

  it('wraps query in transaction and rolls back', async () => {
    const queries: string[] = [];
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        queries.push(sql.trim().split('\n')[0]?.trim() ?? sql);
        if (sql.includes('EXPLAIN')) {
          return Promise.resolve({
            rows: [{ 'QUERY PLAN': samplePgPlan }],
            rowCount: 1,
            fields: [],
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT id FROM users',
    });

    expect(queries[0]).toBe('BEGIN');
    expect(queries[2]).toBe('ROLLBACK');
  });

  it('closes connection on error', async () => {
    const mockDb = {
      query: vi.fn().mockRejectedValue(new Error('syntax error')),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'INVALID SQL',
    });

    expect(result).toHaveProperty('error');
    expect(mockDb.close).toHaveBeenCalled();
  });

  it('returns error when EXPLAIN returns unexpected format', async () => {
    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ 'QUERY PLAN': 'not-an-array' }],
          rowCount: 1,
          fields: [],
        }) // bad EXPLAIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }), // ROLLBACK
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT 1',
    });

    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('Analysis failed');
  });

  it('returns analysis result for MySQL EXPLAIN', async () => {
    const mockDb = {
      query: vi.fn().mockResolvedValueOnce({
        rows: [{ EXPLAIN: { query_block: { select_id: 1 } } }],
        rowCount: 1,
        fields: [],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'mysql://u:p@localhost/db',
      sql: 'SELECT * FROM orders',
    });

    expect(result).not.toHaveProperty('error');
    const success = result as {
      success: true;
      rawPlan: unknown;
      suggestions: string[];
    };
    expect(success.success).toBe(true);
    expect(success.suggestions[0]).toContain('MySQL EXPLAIN');
  });

  it('generates slow-query suggestion when execution time > 1000ms', async () => {
    const slowPlan = [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'big_table',
          'Plan Rows': 10,
          'Actual Rows': 10,
          'Actual Startup Time': 0.1,
          'Actual Total Time': 1100,
          'Actual Loops': 1,
          Plans: [],
        },
        'Planning Time': 5,
        'Execution Time': 1200,
      },
    ];

    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ 'QUERY PLAN': slowPlan }],
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }), // ROLLBACK
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT * FROM big_table',
    });

    const success = result as { success: true; suggestions: string[] };
    expect(success.suggestions.some((s) => s.includes('1200'))).toBe(true);
    expect(success.suggestions.some((s) => s.includes('Sequential scans'))).toBe(true);
  });

  it('generates row mismatch suggestion when estimate is way off', async () => {
    const badEstimatePlan = [
      {
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'huge_table',
          'Plan Rows': 1, // estimated: 1
          'Actual Rows': 100000, // actual: 100000 → ratio = 100000 > 10
          'Actual Startup Time': 0.01,
          'Actual Total Time': 2000,
          'Actual Loops': 1,
          Plans: [],
        },
        'Planning Time': 1,
        'Execution Time': 2500,
      },
    ];

    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ 'QUERY PLAN': badEstimatePlan }],
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }), // ROLLBACK
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: 'SELECT * FROM huge_table',
    });

    const success = result as { success: true; suggestions: string[] };
    expect(success.suggestions.some((s) => s.includes('Row count mismatch'))).toBe(true);
    expect(success.suggestions.some((s) => s.includes('ANALYZE'))).toBe(true);
  });

  it('generates index-used suggestions correctly', async () => {
    const indexPlan = [
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'users',
          'Index Name': 'users_email_idx',
          'Index Cond': "(email = 'a@b.com')",
          'Plan Rows': 1,
          'Actual Rows': 1,
          'Actual Startup Time': 0.01,
          'Actual Total Time': 0.05,
          'Actual Loops': 1,
          Plans: [],
        },
        'Planning Time': 0.5,
        'Execution Time': 0.1,
      },
    ];

    const mockDb = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }) // BEGIN
        .mockResolvedValueOnce({
          rows: [{ 'QUERY PLAN': indexPlan }],
          rowCount: 1,
          fields: [],
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0, fields: [] }), // ROLLBACK
      close: vi.fn().mockResolvedValue(undefined),
    };

    mockCreateConnection.mockResolvedValue(mockDb);

    const result = await dbQueryAnalyze({
      connection_string: 'postgresql://u:p@localhost/db',
      sql: "SELECT * FROM users WHERE email = 'a@b.com'",
    });

    const success = result as {
      success: true;
      indexesUsed: { indexName: string }[];
      suggestions: string[];
    };
    expect(success.indexesUsed[0]?.indexName).toBe('users_email_idx');
    expect(success.suggestions[0]).toContain('healthy');
  });
});
