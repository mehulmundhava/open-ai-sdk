import { Router, Request, Response } from 'express';
import { processChat } from '../controllers/chatController';
import { ChatRequest, ChatResponse } from '../models/schemas';
import { VectorStoreService } from '../services/vectorStore';
import { logger } from '../utils/logger';

/** Strip localhost/absolute URL from download-csv links. Only output /download-csv/{id}. Mutate response in place so res.json sends stripped data. */
function stripLocalhostFromResponse(response: ChatResponse): void {
  const strip = (text: string): string => {
    if (!text || typeof text !== 'string') return text;
    if (!text.includes('download-csv') && !text.includes('localhost')) return text;
    let out = text;
    out = out.split('http://localhost:3009/download-csv/').join('/download-csv/');
    out = out.split('https://localhost:3009/download-csv/').join('/download-csv/');
    out = out.replace(/https?:\/\/[^/]*\/download-csv\//g, '/download-csv/');
    return out;
  };

  const answerBefore = response.answer ?? '';
  const convAnswerBefore = response.debug?.conversation?.answer ?? '';

  logger.info('🔗 [Route] stripLocalhostFromResponse BEFORE', {
    answerHasLocalhost: answerBefore.includes('localhost'),
    answerSnippet: answerBefore.includes('download-csv') ? answerBefore.substring(Math.max(0, answerBefore.indexOf('download-csv') - 25), answerBefore.indexOf('download-csv') + 65) : 'n/a',
    convAnswerHasLocalhost: convAnswerBefore.includes('localhost'),
  });

  // Mutate in place so the same object we send has stripped strings
  if (response.answer) response.answer = strip(response.answer);
  if (response.debug?.conversation && typeof response.debug.conversation.answer === 'string') {
    response.debug.conversation.answer = strip(response.debug.conversation.answer);
  }

  const answerAfter = response.answer ?? '';
  const stillHasLocalhost = answerAfter.includes('localhost');
  if (stillHasLocalhost) {
    logger.warn('🔗 [Route] answer STILL had localhost after strip - applying nuclear replace');
    response.answer = (response.answer as string).replace(/http:\/\/localhost:3009\/download-csv\//g, '/download-csv/');
    response.answer = (response.answer as string).replace(/https:\/\/localhost:3009\/download-csv\//g, '/download-csv/');
  }
  if (response.debug?.conversation?.answer && (response.debug.conversation.answer as string).includes('localhost')) {
    logger.warn('🔗 [Route] debug.conversation.answer STILL had localhost - applying nuclear replace');
    response.debug.conversation.answer = (response.debug.conversation.answer as string).replace(/http:\/\/localhost:3009\/download-csv\//g, '/download-csv/');
    response.debug.conversation.answer = (response.debug.conversation.answer as string).replace(/https:\/\/localhost:3009\/download-csv\//g, '/download-csv/');
  }

  logger.info('🔗 [Route] stripLocalhostFromResponse AFTER', {
    answerStillHasLocalhost: (response.answer ?? '').includes('localhost'),
    answerSnippet: answerAfter.includes('download-csv') ? answerAfter.substring(Math.max(0, answerAfter.indexOf('download-csv') - 15), answerAfter.indexOf('download-csv') + 55) : 'n/a',
  });
}

const router = Router();

// Store vector store service in app state (will be set in app.ts)
declare global {
  namespace Express {
    interface Application {
      vectorStore?: VectorStoreService;
    }
  }
}

router.post('/:chatId/message', async (req: Request, res: Response) => {
  try {
    const chatId = req.params.chatId;
    const payload: ChatRequest = req.body;

    if (!chatId) {
      return res.status(400).json({
        error: 'Missing required parameter: chatId',
      });
    }

    if (!payload.token_id || !payload.question) {
      return res.status(400).json({
        error: 'Missing required fields: token_id and question',
      });
    }

    const vectorStore = req.app.vectorStore;
    if (!vectorStore) {
      return res.status(500).json({
        error: 'Vector store not initialized',
      });
    }

    const response: ChatResponse = await processChat(chatId, payload, vectorStore);

    // Final safety: strip localhost from any download-csv links before sending (mutates response in place)
    stripLocalhostFromResponse(response);

    // Log response and verify no localhost in answer before sending
    const finalAnswer = response.answer ?? '';
    const finalHasLocalhost = finalAnswer.includes('localhost');
    if (finalHasLocalhost) {
      logger.error('🔗 [Route] CRITICAL: response.answer STILL contains localhost before res.json - stripping one more time');
      response.answer = finalAnswer.split('http://localhost:3009/download-csv/').join('/download-csv/').split('https://localhost:3009/download-csv/').join('/download-csv/');
    }
    logger.info('📤 Chat API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      answerContainsLocalhost: (response.answer ?? '').includes('localhost'),
      responsePreview: {
        token_id: response.token_id,
        answerLength: response.answer?.length || 0,
        hasSqlQuery: !!response.sql_query,
        hasCsvId: !!response.csv_id,
        llm_used: response.llm_used,
        llm_type: response.llm_type,
      },
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Chat route error: ${error}`);
    const errorResponse = {
      error: error.message || 'Internal server error',
    };
    logger.error('📤 Chat API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

export default router;
