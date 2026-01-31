import { Router, Request, Response } from 'express';
import { processChat } from '../controllers/chatController';
import { ChatRequest, ChatResponse } from '../models/schemas';
import { VectorStoreService } from '../services/vectorStore';
import { logger } from '../utils/logger';

const router = Router();

// Store vector store service in app state (will be set in app.ts)
declare global {
  namespace Express {
    interface Application {
      vectorStore?: VectorStoreService;
    }
  }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const payload: ChatRequest = req.body;

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

    const response: ChatResponse = await processChat(payload, vectorStore);
    
    // Log response
    logger.info('📤 Chat API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
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
