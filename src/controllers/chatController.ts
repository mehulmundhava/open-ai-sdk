import { ChatRequest, ChatResponse } from '../models/schemas';
import { createChatAgent, runChatAgent } from '../agents/chatAgent';
import { VectorStoreService } from '../services/vectorStore';
import { securityCheck } from '../utils/securityCheck';
import { TokenTracker } from '../utils/tokenTracker';
import { logger, createRequestLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

/**
 * Process chat request and return response
 */
export async function processChat(
  payload: ChatRequest,
  vectorStore: VectorStoreService
): Promise<ChatResponse> {
  const requestId = uuidv4();
  const requestLogger = createRequestLogger(requestId, payload.user_id);

  // Log comprehensive conversation start
  requestLogger.info('💬 CONVERSATION REQUEST', {
    requestId,
    userId: payload.user_id,
    question: payload.question,
    questionLength: payload.question.length,
    chatHistoryLength: payload.chat_history?.length || 0,
    chatHistory: payload.chat_history,
    timestamp: new Date().toISOString(),
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

    // Log comprehensive conversation summary
    requestLogger.info('💬 CONVERSATION SUMMARY', {
      requestId,
      userId: payload.user_id,
      question: payload.question,
      answer: result.answer.substring(0, 200),
      sqlQuery: result.sqlQuery,
      toolCallsCount: result.toolCalls?.length || 0,
      toolErrorsCount: result.toolErrors?.length || 0,
      elapsedTimeMs: elapsedTime,
      tokenUsage: result.tokenUsage,
      hasSqlQuery: !!result.sqlQuery,
      hasQueryResult: !!result.queryResult,
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

    // Build response
    const response: ChatResponse = {
      token_id: payload.token_id,
      answer: result.answer,
      sql_query: result.sqlQuery, // Ensure SQL query is always included
      results: result.queryResult ? { raw: result.queryResult } : undefined,
      llm_used: true,
      llm_type: 'OPENAI/gpt-4o',
      csv_id: result.csvId,
      csv_download_path: result.csvDownloadPath,
      debug: {
        request_id: requestId,
        elapsed_time_ms: elapsedTime,
        token_usage: result.tokenUsage,
        token_usage_history: result.tokenUsage?.stages || [],
        tool_calls: result.toolCalls,
        tool_calls_count: result.toolCalls?.length || 0,
        tool_errors: result.toolErrors,
        tool_errors_count: result.toolErrors?.length || 0,
        sql_query: result.sqlQuery,
        execute_db_query: executeDbQuerySql || journeyToolSql || undefined, // SQL query executed via execute_db_query or journey tools
        query_result: result.queryResult,
        conversation: {
          question: payload.question,
          answer: result.answer,
          chat_history: payload.chat_history,
        },
      },
    };
    
    // Log tool errors if any
    if (result.toolErrors && result.toolErrors.length > 0) {
      requestLogger.error('❌ Tool errors detected:', {
        errors: result.toolErrors,
        sql_query: result.sqlQuery,
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
