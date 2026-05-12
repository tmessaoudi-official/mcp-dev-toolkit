/**
 * db_query_analyze — Runs EXPLAIN ANALYZE on a SQL query.
 * Returns: full plan, estimated vs actual rows, slow nodes, index usage, plain-language suggestions.
 */

import { z } from 'zod';
import { createConnection, sanitizeConnectionString } from '../utils/db-connection.js';

export const DbQueryAnalyzeInput = z.object({
  connection_string: z
    .string()
    .min(1)
    .describe('Database connection string (postgresql:// or mysql://)'),
  sql: z
    .string()
    .min(1)
    .describe('SQL query to analyze (SELECT only recommended; use READ COMMITTED tx)'),
});

export type DbQueryAnalyzeInput = z.infer<typeof DbQueryAnalyzeInput>;

export interface PlanNode {
  nodeType: string;
  actualTimeMs: number | null;
  estimatedRows: number | null;
  actualRows: number | null;
  planRows: number | null;
  loops: number | null;
  totalTimeMs: number | null;
  detail: Record<string, unknown>;
  isSlow: boolean;
  children: PlanNode[];
}

export interface IndexUsage {
  indexName: string;
  table: string;
  condition: string;
  scanType: 'Index Scan' | 'Index Only Scan' | 'Bitmap Index Scan' | string;
}

export interface QueryAnalysisResult {
  success: true;
  totalPlanningTimeMs: number | null;
  totalExecutionTimeMs: number | null;
  rawPlan: unknown;
  planSummary: PlanNode;
  slowNodes: PlanNode[];
  indexesUsed: IndexUsage[];
  sequentialScans: string[];
  suggestions: string[];
}

export interface QueryAnalysisError {
  error: string;
  details?: Record<string, unknown>;
}

export async function dbQueryAnalyze(
  input: DbQueryAnalyzeInput,
): Promise<QueryAnalysisResult | QueryAnalysisError> {
  const db = await createConnection(input.connection_string).catch((err: unknown) => ({
    error: `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
    details: { connection: sanitizeConnectionString(input.connection_string) },
  }));

  if ('error' in db) return db as QueryAnalysisError;

  try {
    const isPostgres = input.connection_string.toLowerCase().startsWith('post');

    if (isPostgres) {
      return await analyzePostgres(db, input.sql);
    }
    return await analyzeMysql(db, input.sql);
  } catch (err) {
    return {
      error: `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      details: { connection: sanitizeConnectionString(input.connection_string) },
    };
  } finally {
    await db.close().catch(() => {});
  }
}

import type { DbConnection } from '../utils/db-connection.js';

async function analyzePostgres(db: DbConnection, sql: string): Promise<QueryAnalysisResult> {
  // Wrap in a transaction we will rollback — prevents accidental data mutation
  await db.query('BEGIN');
  let planResult: Awaited<ReturnType<typeof db.query>>;
  try {
    planResult = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
  } finally {
    await db.query('ROLLBACK');
  }

  interface PgExplainPlan {
    'Planning Time'?: number;
    'Execution Time'?: number;
    Plan?: Record<string, unknown>;
  }
  interface PgQueryPlanRow {
    'QUERY PLAN'?: PgExplainPlan[];
  }

  const firstRow = planResult.rows[0] as PgQueryPlanRow | undefined;
  const planJson = firstRow?.['QUERY PLAN'];
  if (!Array.isArray(planJson) || planJson.length === 0) {
    throw new Error('Unexpected EXPLAIN output format');
  }

  const plan = planJson[0] as PgExplainPlan;
  const planningTime = plan['Planning Time'] ?? null;
  const executionTime = plan['Execution Time'] ?? null;
  const rootNode = plan.Plan ?? {};

  const planSummary = parsePostgresNode(rootNode, executionTime);
  const slowNodes = collectSlowNodes(planSummary);
  const indexesUsed = collectIndexes(planSummary);
  const seqScans = collectSeqScans(planSummary);
  const suggestions = generateSuggestions({ slowNodes, indexesUsed, seqScans, executionTime });

  return {
    success: true,
    totalPlanningTimeMs: planningTime,
    totalExecutionTimeMs: executionTime,
    rawPlan: plan,
    planSummary,
    slowNodes,
    indexesUsed,
    sequentialScans: seqScans,
    suggestions,
  };
}

interface PgPlanNode {
  'Node Type'?: string;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Actual Startup Time'?: number;
  'Actual Total Time'?: number;
  Plans?: PgPlanNode[];
  'Relation Name'?: string;
  Alias?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Filter?: string;
  'Join Type'?: string;
  'Hash Cond'?: string;
  'Sort Key'?: string;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: intentional — parses PostgreSQL EXPLAIN JSON node tree, complexity is inherent in the data structure
function parsePostgresNode(node: PgPlanNode, totalMs: number | null): PlanNode {
  const nodeType = String(node['Node Type'] ?? 'Unknown');
  const estimatedRows = node['Plan Rows'] ?? null;
  const actualRows = node['Actual Rows'] ?? null;
  const planRows = estimatedRows;
  const loops = node['Actual Loops'] ?? null;
  const startupTime = node['Actual Startup Time'] ?? null;
  const totalTime = node['Actual Total Time'] ?? null;

  const actualTimeMs = totalTime !== null && startupTime !== null ? totalTime - startupTime : null;

  const isSlow = totalMs !== null && totalTime !== null && totalTime > totalMs * 0.5;

  const children = Array.isArray(node.Plans)
    ? node.Plans.map((c) => parsePostgresNode(c, totalMs))
    : [];

  // Build detail object with interesting fields
  const detail: Record<string, unknown> = {};
  if (node['Relation Name'] !== undefined) detail['Relation Name'] = node['Relation Name'];
  if (node.Alias !== undefined) detail.Alias = node.Alias;
  if (node['Index Name'] !== undefined) detail['Index Name'] = node['Index Name'];
  if (node['Index Cond'] !== undefined) detail['Index Cond'] = node['Index Cond'];
  if (node.Filter !== undefined) detail.Filter = node.Filter;
  if (node['Join Type'] !== undefined) detail['Join Type'] = node['Join Type'];
  if (node['Hash Cond'] !== undefined) detail['Hash Cond'] = node['Hash Cond'];
  if (node['Sort Key'] !== undefined) detail['Sort Key'] = node['Sort Key'];

  return {
    nodeType,
    actualTimeMs,
    estimatedRows,
    actualRows,
    planRows,
    loops,
    totalTimeMs: totalTime,
    detail,
    isSlow,
    children,
  };
}

function collectSlowNodes(node: PlanNode): PlanNode[] {
  const slow: PlanNode[] = [];
  const visit = (n: PlanNode) => {
    if (n.isSlow) slow.push(n);
    for (const child of n.children) visit(child);
  };
  visit(node);
  return slow;
}

function collectIndexes(node: PlanNode): IndexUsage[] {
  const indexes: IndexUsage[] = [];
  const visit = (n: PlanNode) => {
    if (
      (n.nodeType === 'Index Scan' ||
        n.nodeType === 'Index Only Scan' ||
        n.nodeType === 'Bitmap Index Scan') &&
      typeof n.detail['Index Name'] === 'string'
    ) {
      indexes.push({
        indexName: n.detail['Index Name'],
        table:
          typeof n.detail['Relation Name'] === 'string' ? n.detail['Relation Name'] : 'unknown',
        condition: typeof n.detail['Index Cond'] === 'string' ? n.detail['Index Cond'] : '',
        scanType: n.nodeType as IndexUsage['scanType'],
      });
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
  return indexes;
}

function collectSeqScans(node: PlanNode): string[] {
  const scans: string[] = [];
  const visit = (n: PlanNode) => {
    if (n.nodeType === 'Seq Scan' && typeof n.detail['Relation Name'] === 'string') {
      scans.push(n.detail['Relation Name']);
    }
    for (const child of n.children) visit(child);
  };
  visit(node);
  return scans;
}

interface SuggestionContext {
  slowNodes: PlanNode[];
  indexesUsed: IndexUsage[];
  seqScans: string[];
  executionTime: number | null;
}

function slowNodeSuggestion(node: PlanNode, executionTime: number | null): string {
  const pct =
    node.totalTimeMs !== null && executionTime
      ? Math.round((node.totalTimeMs / executionTime) * 100)
      : null;
  const pctStr = pct !== null ? ` (${pct}% of total)` : '';
  const rowDrift =
    node.estimatedRows !== null && node.actualRows !== null
      ? Math.abs(node.estimatedRows - node.actualRows)
      : 0;
  const driftNote =
    rowDrift > 10 ? ` Row estimate was off by ${rowDrift} — run ANALYZE on the table.` : '';
  return `Slow node '${node.nodeType}'${pctStr}: took ${node.totalTimeMs?.toFixed(1) ?? '?'}ms.${driftNote}`;
}

function rowMismatchSuggestion(node: PlanNode): string | null {
  if (node.estimatedRows === null || node.actualRows === null) return null;
  const ratio = node.estimatedRows > 0 ? node.actualRows / node.estimatedRows : 0;
  if (ratio > 10 || ratio < 0.1) {
    return (
      `Row count mismatch in '${node.nodeType}': estimated ${node.estimatedRows}, ` +
      `got ${node.actualRows}. Run ANALYZE to refresh table statistics.`
    );
  }
  return null;
}

function generateSuggestions(ctx: SuggestionContext): string[] {
  const suggestions: string[] = [];

  if (ctx.executionTime !== null && ctx.executionTime > 1000) {
    suggestions.push(
      `Query took ${ctx.executionTime.toFixed(1)}ms — consider caching results or optimizing.`,
    );
  }

  if (ctx.seqScans.length > 0) {
    suggestions.push(
      `Sequential scans detected on: ${ctx.seqScans.join(', ')}. ` +
        `Consider adding indexes on frequently filtered columns.`,
    );
  }

  for (const node of ctx.slowNodes) {
    suggestions.push(slowNodeSuggestion(node, ctx.executionTime));
    const mismatch = rowMismatchSuggestion(node);
    if (mismatch) suggestions.push(mismatch);
  }

  if (ctx.indexesUsed.length === 0 && ctx.seqScans.length > 0) {
    suggestions.push(
      'No indexes used. Review WHERE clauses and ensure indexed columns match filter expressions.',
    );
  }

  if (suggestions.length === 0) {
    suggestions.push('Query plan looks healthy — no obvious bottlenecks detected.');
  }

  return suggestions;
}

interface MysqlExplainRow {
  EXPLAIN?: unknown;
}

async function analyzeMysql(db: DbConnection, sql: string): Promise<QueryAnalysisResult> {
  const result = await db.query(`EXPLAIN FORMAT=JSON ${sql}`);
  const explainRow = result.rows[0] as MysqlExplainRow | undefined;
  const rawPlan = explainRow?.EXPLAIN ?? result.rows[0];

  // MySQL EXPLAIN JSON has a different structure
  const suggestions: string[] = [
    'MySQL EXPLAIN FORMAT=JSON returned. Check raw plan for full_scan and using_index fields.',
  ];

  return {
    success: true,
    totalPlanningTimeMs: null,
    totalExecutionTimeMs: null,
    rawPlan,
    planSummary: {
      nodeType: 'MySQL Query Block',
      actualTimeMs: null,
      estimatedRows: null,
      actualRows: null,
      planRows: null,
      loops: null,
      totalTimeMs: null,
      detail: { note: 'Use EXPLAIN ANALYZE (MySQL 8.0.18+) for timing data' },
      isSlow: false,
      children: [],
    },
    slowNodes: [],
    indexesUsed: [],
    sequentialScans: [],
    suggestions,
  };
}
