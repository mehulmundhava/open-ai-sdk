import { ChatRequest, ChatResponse } from '../models/schemas';
import { createChatAgent, runChatAgent } from '../agents/chatAgent';
import { VectorStoreService } from '../services/vectorStore';
import { securityCheck } from '../utils/securityCheck';
import { TokenTracker } from '../utils/tokenTracker';
import { logger, createRequestLogger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { AiChat, AiChatMessage } from '../models';
import { getAiModelName } from '../config/aiSettings';
import {
  type ToolCallItem,
  stripLocalhostFromCsvLinks,
  getLastBunchFromHistory,
  extractSqlFromMessageSubArray,
  getLastSqlFromToolCalls,
  normalizeSqlQuery,
} from './helper/chatControllerHelpers';

/**
 * Process chat request and return response
 */
export async function processChat(
  chatId: string,
  payload: ChatRequest,
  vectorStore: VectorStoreService
): Promise<ChatResponse> {
  const requestId = uuidv4();

  // Fetch chat entry to get user_id
  let chatEntry;
  try {
    chatEntry = await AiChat.findByPk(chatId);
    if (!chatEntry) {
      throw new Error(`Chat entry not found for chatId: ${chatId}`);
    }
  } catch (error: any) {
    logger.error(`❌ Error fetching chat entry: ${error?.message} for chatId: ${chatId}`);
    return {
      token_id: payload.token_id,
      answer: `Error: Chat entry not found. Please create a new chat entry first. for chatId: ${chatId}`,
      llm_used: false,
      error: error?.message || 'Chat entry not found',
    };
  }

  const userId = String(chatEntry.user_id);
  const requestLogger = createRequestLogger(requestId, userId);

  requestLogger.info('💬 REQUEST', {
    requestId,
    userId: payload.user_id,
    chatId,
    question: payload.question?.substring(0, 80),
    chatHistoryLength: payload.chat_history?.length || 0,
  });

  // Authentication validation
  if (payload.token_id !== 'Test123') {
    throw new Error('Session ID is not proper');
  }

  // Security check for non-admin users (no chat history; short non-threatening answers allowed via fast path)
  let securityFailureReason: string | undefined;
  if (userId && userId.toLowerCase() !== 'admin') {
    try {
      const securityResult = await securityCheck(payload.question, userId);// { allowed: true, reason: 'Query allowed by security check' }; 
      if (!securityResult.allowed) {
        securityFailureReason = securityResult.reason || 'Query blocked by security check';
        requestLogger.warn(`🔒 Security check BLOCKED query`, {
          userId,
          question: payload.question,
          reason: securityFailureReason,
        });

        const securityBlockedResponse: ChatResponse = {
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
              userId,
            },
          },
        };

        // Save security blocked message to database
        try {
          await AiChatMessage.create({
            chat_id: chatId,
            user_id: chatEntry.user_id,
            user_message: payload.question,
            response_message: securityBlockedResponse.answer,
            response: securityBlockedResponse, // Full response object as JSONB
            token_consumption: null, // No token consumption for blocked requests
          });
          requestLogger.info('✅ Saved security blocked message to database', {
            chatId,
          });
        } catch (saveError: any) {
          requestLogger.error('⚠️  Failed to save security blocked message to database:', {
            error: saveError?.message,
            chatId,
          });
          // Continue even if save fails
        }

        return securityBlockedResponse;
      } else {
        requestLogger.info(`✅ Security check ALLOWED query`, {
          userId,
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
  const tokenTracker = new TokenTracker(requestId, userId);

  try {
    // Create chat agent
    const agent = await createChatAgent({
      userId,
      topK: 20,
      vectorStore,
    });

    // Run agent with conversation session
    const startTime = Date.now();
    const result: any = await runChatAgent(
      agent,
      payload.question,
      userId,
      vectorStore,
      tokenTracker,
      chatId, // conversationId
    );
    const elapsedTime = Date.now() - startTime;

    // Log result to file only (no console) to avoid noisy console output
    requestLogger.fileOnly.info('💬 RESULT', {
      result,
    });

    // Update last_message_at after processing
    try {
      await chatEntry.update({
        last_message_at: new Date(),
      });
      requestLogger.info('✅ Updated last_message_at for chat entry');
    } catch (updateError: any) {
      requestLogger.error(`⚠️  Failed to update last_message_at: ${updateError?.message}`);
      // Continue even if update fails
    }

    requestLogger.info(`[chat] agent done in ${elapsedTime}ms`);

    const allToolCalls = (result.toolCalls ?? []) as ToolCallItem[];

    // Chain of thought: (1) extract last bunch from history (from end until role:'user')
    const lastBunchMessages = getLastBunchFromHistory(result.history);
    requestLogger.fileOnly.info('💬 LAST BUNCH MESSAGES', {
      lastBunchMessages,
    });
    // (2) from last-bunch messages sub-array, extract last SQL query
    const lastSql =
      extractSqlFromMessageSubArray(lastBunchMessages) ?? getLastSqlFromToolCalls(allToolCalls);
    const responseSqlQuery = lastSql?.query ?? result.sqlQuery;
    const executeDbQuerySql = lastSql?.executeDbQuerySql;
    const journeyToolSql = lastSql?.journeyToolSql;

    requestLogger.info('💬 SUMMARY', {
      requestId,
      question: payload.question?.substring(0, 60),
      answerLen: result.answer?.length ?? 0,
      hasSql: !!result.sqlQuery,
      elapsedMs: elapsedTime,
    });

    // Process answer to strip localhost URLs (already done in agentResponseProcessor, but double-check)
    const processedAnswer = stripLocalhostFromCsvLinks(result.answer);

    // Normalize SQL query (remove line breaks and extra whitespace) — use last SQL
    const normalizedSqlQuery = normalizeSqlQuery(responseSqlQuery);

    // Model name from DB (same source as agent) for accurate llm_type in response
    const aiModelName = await getAiModelName();

    // Build response
    const response: ChatResponse = {
      token_id: payload.token_id,
      answer: processedAnswer,
      sql_query: normalizedSqlQuery,
      results: result.queryResult ? { raw: result.queryResult } : undefined,
      llm_used: true,
      llm_type: `OPENAI/${aiModelName}`,
      csv_id: result.csvId,
      csv_download_path: result.csvDownloadPath,
      debug: {
        request_id: requestId,
        elapsed_time_ms: elapsedTime,
        sql_query: normalizedSqlQuery,
        execute_db_query: executeDbQuerySql ?? journeyToolSql ?? undefined,
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

    // Log if SQL query is missing (after using last SQL from tool calls)
    if (!normalizedSqlQuery && allToolCalls.length > 0) {
      requestLogger.warn('⚠️  SQL query not extracted from tool calls', {
        toolCalls: allToolCalls.map((tc) => ({ tool: tc.tool, input: tc.input })),
      });
    }

    // Save chat message to database before returning response
    try {
      await AiChatMessage.create({
        chat_id: chatId,
        user_id: chatEntry.user_id,
        user_message: payload.question,
        response_message: processedAnswer,
        response: response, // Full response object as JSONB
        token_consumption: result.tokenUsage || null, // Token usage data as JSONB
        history: result.history || null,
      });
      requestLogger.info('✅ Saved chat message to database', {
        chatId,
        messageId: 'saved',
      });
    } catch (saveError: any) {
      requestLogger.error('⚠️  Failed to save chat message to database:', {
        error: saveError?.message,
        chatId,
      });
      // Continue even if save fails - don't block the response
    }

    return response;
  } catch (error: any) {
    const errorDetails = {
      message: error?.message || String(error),
      stack: error?.stack || 'No stack trace',
      name: error?.name || 'UnknownError',
    };
    requestLogger.error('❌ Error processing chat:', errorDetails);

    // Build error response
    const errorResponse: ChatResponse = {
      token_id: payload.token_id,
      answer: `I encountered an error while processing your request: ${errorDetails.message}. Please check the logs for more details.`,
      llm_used: false,
      error: errorDetails.message,
      debug: {
        request_id: requestId,
        error: errorDetails,
      },
    };

    // Save error message to database if chatEntry is available
    if (chatEntry) {
      try {
        await AiChatMessage.create({
          chat_id: chatId,
          user_id: chatEntry.user_id,
          user_message: payload.question,
          response_message: errorResponse.answer,
          response: errorResponse, // Full error response object as JSONB
          token_consumption: null, // No token consumption for errors
        });
        requestLogger.info('✅ Saved error chat message to database', {
          chatId,
        });
      } catch (saveError: any) {
        requestLogger.error('⚠️  Failed to save error chat message to database:', {
          error: saveError?.message,
          chatId,
        });
        // Continue even if save fails
      }
    }

    return errorResponse;
  }
}
