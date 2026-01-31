import { Router, Request, Response } from 'express';
import { VectorStoreService } from '../services/vectorStore';
import { VectorSearchRequest, VectorSearchResponse } from '../models/schemas';
import { logger } from '../utils/logger';

const router = Router();

declare global {
  namespace Express {
    interface Application {
      vectorStore?: VectorStoreService;
    }
  }
}

router.post('/', async (req: Request, res: Response) => {
  try {
    const payload: VectorSearchRequest = req.body;

    if (!payload.question) {
      return res.status(400).json({
        error: 'Missing required field: question',
      });
    }

    const vectorStore = req.app.vectorStore;
    if (!vectorStore) {
      return res.status(500).json({
        error: 'Vector store not initialized',
      });
    }

    const searchType = payload.search_type || 'both';
    const kExamples = payload.k_examples || 2;
    const kExtraPrompts = payload.k_extra_prompts || 1;

    const response: VectorSearchResponse = {
      status: 'success',
      question: payload.question,
      search_type: searchType,
      total_results: 0,
    };

    if (searchType === 'examples' || searchType === 'both') {
      const examples = await vectorStore.searchExamples(
        payload.question,
        kExamples,
        payload.example_id
      );
      response.examples = examples.map((ex) => ({
        id: ex.id,
        content: ex.content,
        distance: ex.distance,
        similarity: ex.similarity,
        metadata: ex.metadata,
      }));
      response.total_results += examples.length;
    }

    if (searchType === 'extra_prompts' || searchType === 'both') {
      const extraPrompts = await vectorStore.searchExtraPrompts(
        payload.question,
        kExtraPrompts,
        payload.extra_prompts_id
      );
      response.extra_prompts = extraPrompts.map((ep) => ({
        id: ep.id,
        content: ep.content,
        distance: ep.distance,
        similarity: ep.similarity,
        metadata: ep.metadata,
      }));
      response.total_results += extraPrompts.length;
    }

    logger.info('📤 Vector Search API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      responsePreview: {
        status: response.status,
        question: response.question,
        search_type: response.search_type,
        total_results: response.total_results,
        examplesCount: response.examples?.length || 0,
        extraPromptsCount: response.extra_prompts?.length || 0,
      },
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Vector search route error: ${error}`);
    const errorResponse = {
      error: error.message || 'Internal server error',
    };
    logger.error('📤 Vector Search API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

export default router;
