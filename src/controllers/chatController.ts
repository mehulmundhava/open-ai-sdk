import { ChatRequest, ChatResponse } from '../models/schemas';
import { createChatAgent, runChatAgent } from '../agents/chatAgent';
import { VectorStoreService } from '../services/vectorStore';
import { securityCheck } from '../utils/securityCheck';
import { TokenTracker } from '../utils/tokenTracker';
import { logger, createRequestLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/** Strip localhost or any origin from download-csv URLs so response never exposes API base URL. */
function stripLocalhostFromCsvLinks(text: string): string {
  if (!text || !text.includes('download-csv')) return text;
  const before = text;
  // Literal first (most reliable): replace exact localhost URL with relative path
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

/** Build a minimal token summary from full token usage report (for logs and API response). */
function simplifyTokenUsage(tokenUsage: any): { prompt: number; completion: number; total: number; cached?: number; stagesCount?: number } | undefined {
  if (!tokenUsage?.total) return undefined;
  const t = tokenUsage.total;
  const cached = t.cachedTokens ?? tokenUsage.stages?.reduce?.((s: number, st: any) => s + (st.tokens?.cachedTokens ?? 0), 0);
  return {
    prompt: t.promptTokens ?? 0,
    completion: t.completionTokens ?? 0,
    total: t.totalTokens ?? 0,
    ...(cached > 0 && { cached }),
    ...(Array.isArray(tokenUsage.stages) && { stagesCount: tokenUsage.stages.length }),
  };
}

/** Build tools_used as object keyed by tool name with token usage per tool (attributed from stages in order). */
function buildToolsUsedWithTokens(result: { toolCalls?: Array<{ tool: string; input?: any }>; tokenUsage?: any }): Record<
  string,
  { prompt: number; completion: number; total: number; call_count?: number }
> {
  const toolCalls = result.toolCalls ?? [];
  const stages = result.tokenUsage?.stages;
  // Use only stages that have non-zero usage (avoid duplicate entries like .providerData / .usage)
  const stagesWithUsage = Array.isArray(stages)
    ? stages.filter((s: any) => (s.tokens?.promptTokens ?? 0) > 0 || (s.tokens?.completionTokens ?? 0) > 0)
    : [];
  // Dedupe by (prompt, completion) so we count each distinct API call once
  const seen = new Set<string>();
  const uniqueStages = stagesWithUsage.filter((s: any) => {
    const key = `${s.tokens?.promptTokens ?? 0}-${s.tokens?.completionTokens ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const zero = { prompt: 0, completion: 0, total: 0 };
  const perCall: Array<{ prompt: number; completion: number; total: number }> = toolCalls.map((_, i) => {
    const stage = uniqueStages[i];
    if (!stage?.tokens) return zero;
    return {
      prompt: stage.tokens.promptTokens ?? 0,
      completion: stage.tokens.completionTokens ?? 0,
      total: stage.tokens.totalTokens ?? 0,
    };
  });

  const byTool: Record<string, { prompt: number; completion: number; total: number; call_count: number }> = {};
  toolCalls.forEach((tc, i) => {
    const name = tc.tool;
    const usage = perCall[i] ?? zero;
    if (!byTool[name]) {
      byTool[name] = { prompt: 0, completion: 0, total: 0, call_count: 0 };
    }
    byTool[name].prompt += usage.prompt;
    byTool[name].completion += usage.completion;
    byTool[name].total += usage.total;
    byTool[name].call_count += 1;
  });
  return byTool;
}

/**
 * Normalize SQL query by removing line breaks and extra whitespace
 * Makes the query executable in adminer.php and other SQL tools
 */
function normalizeSqlQuery(sqlQuery: string | undefined): string | undefined {
  if (!sqlQuery) return undefined;
  
  // Replace line breaks (\n, \r\n, \r) with spaces
  let normalized = sqlQuery.replace(/\r\n/g, ' ').replace(/\n/g, ' ').replace(/\r/g, ' ');
  
  // Replace multiple consecutive spaces with a single space
  normalized = normalized.replace(/\s+/g, ' ');
  
  // Trim leading and trailing whitespace
  normalized = normalized.trim();
  
  return normalized;
}

/**
 * Process chat request and return response
 */
export async function processChat(
  payload: ChatRequest,
  vectorStore: VectorStoreService
): Promise<ChatResponse> {
  const requestId = uuidv4();
  const requestLogger = createRequestLogger(requestId, payload.user_id);

  requestLogger.info('💬 REQUEST', {
    requestId,
    userId: payload.user_id,
    question: payload.question?.substring(0, 80),
    chatHistoryLength: payload.chat_history?.length || 0,
  });

  // Authentication validation
  if (payload.token_id !== 'Test123') {
    throw new Error('Session ID is not proper');
  }

  // Security check for non-admin users
  let securityFailureReason: string | undefined;
  if (payload.user_id && payload.user_id.toLowerCase() !== 'admin') {
    try {
      const securityResult = await securityCheck(payload.question, payload.user_id);
      if (!securityResult.allowed) {
        securityFailureReason = securityResult.reason || 'Query blocked by security check';
        requestLogger.warn(`🔒 Security check BLOCKED query`, {
          userId: payload.user_id,
          question: payload.question,
          reason: securityFailureReason,
        });
        return {
          token_id: payload.token_id,
          answer: `Sorry, I cannot process that request. ${securityFailureReason}`,
          security_failure_reason: securityFailureReason,
          security_blocked: true,
          llm_used: false,
          debug: {
            request_id: requestId,
            security_check: {
              blocked: true,
              reason: securityFailureReason,
              question: payload.question,
              userId: payload.user_id,
            },
          },
        };
      } else {
        requestLogger.info(`✅ Security check ALLOWED query`, {
          userId: payload.user_id,
          question: payload.question,
          reason: securityResult.reason,
        });
      }
    } catch (error: any) {
      requestLogger.error(`Security check error: ${error}`);
      // Continue processing on security check error (fail open)
    }
  }

  // Initialize token tracker
  const tokenTracker = new TokenTracker(requestId, payload.user_id);

  try {
    // Create chat agent
    const agent = await createChatAgent({
      userId: payload.user_id,
      topK: 20,
      vectorStore,
    });

    // Run agent
    const startTime = Date.now();
    const result = await runChatAgent(
      agent,
      payload.question,
      payload.user_id || 'admin',
      vectorStore,
      tokenTracker
    );
    const elapsedTime = Date.now() - startTime;

    requestLogger.info(`[chat] agent done in ${elapsedTime}ms`);

    const tokenSummary = simplifyTokenUsage(result.tokenUsage);
    const tools_used = buildToolsUsedWithTokens(result);
    requestLogger.info('💬 SUMMARY', {
      requestId,
      question: payload.question?.substring(0, 60),
      answerLen: result.answer?.length ?? 0,
      hasSql: !!result.sqlQuery,
      toolCalls: result.toolCalls?.length ?? 0,
      toolErrors: result.toolErrors?.length ?? 0,
      elapsedMs: elapsedTime,
      tokens: tokenSummary,
    });

    // Check if execute_db_query tool was used
    const executeDbQueryCall = result.toolCalls?.find(
      (tc) => tc.tool === 'execute_db_query'
    );
    const executeDbQuerySql = executeDbQueryCall?.input?.query || 
                              (executeDbQueryCall?.input?.sql ? executeDbQueryCall.input.sql : undefined) ||
                              result.sqlQuery;
    
    // Also check journey tools for SQL
    const journeyToolCall = result.toolCalls?.find(
      (tc) => tc.tool === 'journey_list_tool' || tc.tool === 'journey_count_tool'
    );
    const journeyToolSql = journeyToolCall?.input?.sql;

    const totalCachedTokens = result.tokenUsage?.total?.cachedTokens
      ?? result.tokenUsage?.stages?.reduce?.((sum: number, stage: any) => sum + (stage.tokens?.cachedTokens || 0), 0) ?? 0;

    // Process answer to strip localhost URLs (already done in agentResponseProcessor, but double-check)
    const processedAnswer = stripLocalhostFromCsvLinks(result.answer);

    // Normalize SQL query (remove line breaks and extra whitespace)
    const normalizedSqlQuery = normalizeSqlQuery(result.sqlQuery);

    // Build response
    const response: ChatResponse = {
      token_id: payload.token_id,
      answer: processedAnswer,
      sql_query: normalizedSqlQuery,
      results: result.queryResult ? { raw: result.queryResult } : undefined,
      llm_used: true,
      llm_type: 'OPENAI/gpt-4o',
      csv_id: result.csvId,
      csv_download_path: result.csvDownloadPath,
      debug: {
        request_id: requestId,
        elapsed_time_ms: elapsedTime,
        token_usage: tokenSummary ?? { prompt: 0, completion: 0, total: 0 },
        tools_used,
        cached_tokens: totalCachedTokens,
        tool_calls_count: result.toolCalls?.length ?? 0,
        tool_errors_count: result.toolErrors?.length ?? 0,
        sql_query: normalizedSqlQuery,
        execute_db_query: executeDbQuerySql || journeyToolSql || undefined,
        query_result: result.queryResult,
        conversation: {
          question: payload.question,
          answer: processedAnswer,
          chat_history: payload.chat_history,
        },
      },
    };
    
    // Log tool errors if any
    if (result.toolErrors && result.toolErrors.length > 0) {
      requestLogger.error('❌ Tool errors detected:', {
        errors: result.toolErrors,
        sql_query: normalizedSqlQuery,
        tool_calls: result.toolCalls,
      });
    }
    
    // Log if SQL query is missing
    if (!result.sqlQuery && result.toolCalls && result.toolCalls.length > 0) {
      requestLogger.warn('⚠️  SQL query not extracted from tool calls', {
        toolCalls: result.toolCalls.map(tc => ({
          tool: tc.tool,
          input: tc.input,
        })),
      });
    }

    return response;
  } catch (error: any) {
    const errorDetails = {
      message: error?.message || String(error),
      stack: error?.stack || 'No stack trace',
      name: error?.name || 'UnknownError',
    };
    requestLogger.error('❌ Error processing chat:', errorDetails);
    
    // Return error response instead of throwing
    return {
      token_id: payload.token_id,
      answer: `I encountered an error while processing your request: ${errorDetails.message}. Please check the logs for more details.`,
      llm_used: false,
      error: errorDetails.message,
      debug: {
        request_id: requestId,
        error: errorDetails,
      },
    };
  }
}
