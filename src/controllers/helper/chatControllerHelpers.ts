import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolCallItem = { tool: string; input?: { query?: string; sql?: string } };

export type HistoryMessage = {
  role?: string;
  type?: string;
  name?: string;
  arguments?: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string | object } }>;
  /** SDK sometimes nests function_call in providerData */
  providerData?: { function?: { name?: string; arguments?: string } };
};

export type LastSqlResult = {
  query: string;
  executeDbQuerySql?: string;
  journeyToolSql?: string;
};

// ---------------------------------------------------------------------------
// CSV / URL helpers
// ---------------------------------------------------------------------------

/** Strip localhost or any origin from download-csv URLs so response never exposes API base URL. */
export function stripLocalhostFromCsvLinks(text: string): string {
  if (!text || !text.includes('download-csv')) return text;
  const before = text;
  let out = text.split('http://localhost:3009/download-csv/').join('/download-csv/');
  out = out.split('https://localhost:3009/download-csv/').join('/download-csv/');
  out = out.replace(/https?:\/\/[^/]*\/download-csv\//g, '/download-csv/');
  out = out.replace(/sandbox:\/download-csv\//g, '/download-csv/');
  const changed = out !== before;
  if (changed || before.includes('localhost')) {
    logger.info('🔗 [Controller] stripLocalhostFromCsvLinks', {
      hadLocalhost: before.includes('localhost'),
      changed,
      stillHasLocalhost: out.includes('localhost'),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// History & last-bunch (chain of thought)
// ---------------------------------------------------------------------------

const SQL_TOOL_NAMES = new Set([
  'execute_db_query',
  'count_query',
  'list_query',
  'facility_journey_list_tool',
  'facility_journey_count_tool',
]);

/**
 * Extract last bunch of messages from the end of the history array until we hit
 * an object with role: 'user'. Returns sub-array from that user message to end (inclusive).
 */
export function getLastBunchFromHistory(history: unknown): HistoryMessage[] {
  const arr = Array.isArray(history) ? history : [];
  if (arr.length === 0) return [];
  let lastUserIndex = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    const msg = arr[i] as HistoryMessage;
    if (msg?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) return arr as HistoryMessage[];
  return arr.slice(lastUserIndex) as HistoryMessage[];
}

/** Parse tool arguments JSON and return query/sql field for SQL tool names. */
function parseSqlFromArgs(
  name: string,
  raw: string | object | undefined,
): { query: string; tool: string } | undefined {
  if (!raw) return undefined;
  let args: Record<string, string> = {};
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? {});
  } catch {
    return undefined;
  }
  const query =
    name === 'facility_journey_list_tool' || name === 'facility_journey_count_tool'
      ? args.sql
      : args.query ?? args.sql;
  if (query && typeof query === 'string' && query.trim().toUpperCase().startsWith('SELECT')) {
    return { query, tool: name };
  }
  return undefined;
}

/**
 * From a sub-array of messages (last bunch), extract the last SQL query.
 * Supports:
 * 1) function_call messages: type='function_call', name in (list_query|count_query|execute_db_query|...), arguments JSON with "query" or "sql".
 * 2) assistant messages with tool_calls[].function.name and function.arguments.
 */
export function extractSqlFromMessageSubArray(messages: HistoryMessage[]): LastSqlResult | undefined {
  let lastSql: { query: string; tool: string } | undefined;
  for (const msg of messages) {
    // Format 1: Top-level function_call message (e.g. OpenAI Agents SDK history)
    if (msg?.type === 'function_call' && msg?.name && SQL_TOOL_NAMES.has(msg.name)) {
      const raw =
        msg.arguments ?? msg.providerData?.function?.arguments;
      const parsed = parseSqlFromArgs(msg.name, raw);
      if (parsed) lastSql = parsed;
      continue;
    }
    // Format 2: Assistant message with tool_calls
    if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      const name = (tc?.function?.name ?? '') as string;
      if (!SQL_TOOL_NAMES.has(name)) continue;
      const parsed = parseSqlFromArgs(name, tc.function?.arguments);
      if (parsed) lastSql = parsed;
    }
  }
  if (!lastSql) return undefined;
  const executeDbQuerySql = lastSql.tool === 'execute_db_query' ? lastSql.query : undefined;
  const journeyToolSql =
    lastSql.tool === 'facility_journey_list_tool' || lastSql.tool === 'facility_journey_count_tool'
      ? lastSql.query
      : undefined;
  return { query: lastSql.query, executeDbQuerySql, journeyToolSql };
}

/** Fallback: get last SQL from flat toolCalls when history is not available. */
export function getLastSqlFromToolCalls(toolCalls: ToolCallItem[]): LastSqlResult | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i];
    if (!SQL_TOOL_NAMES.has(tc.tool)) continue;
    const input = tc.input ?? {};
    const query =
      tc.tool === 'facility_journey_list_tool' || tc.tool === 'facility_journey_count_tool'
        ? input.sql
        : input.query ?? input.sql;
    if (query && typeof query === 'string') {
      const executeDbQuerySql = tc.tool === 'execute_db_query' ? query : undefined;
      const journeyToolSql =
        tc.tool === 'facility_journey_list_tool' || tc.tool === 'facility_journey_count_tool'
          ? query
          : undefined;
      return { query, executeDbQuerySql, journeyToolSql };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SQL normalization
// ---------------------------------------------------------------------------

/** Normalize SQL query (remove line breaks and extra whitespace) for adminer.php and other SQL tools. */
export function normalizeSqlQuery(sqlQuery: string | undefined): string | undefined {
  if (!sqlQuery) return undefined;
  let normalized = sqlQuery.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  return normalized;
}
