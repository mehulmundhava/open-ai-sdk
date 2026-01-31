import { Router, Request, Response } from 'express';
import { sequelizeUpdate, sequelizeReadOnly } from '../config/database';
import { VectorExample, VectorExtraPrompt } from '../models';
import { embedQuery, getEmbeddingFieldName } from '../services/embeddings';
import { VectorStoreService } from '../services/vectorStore';
import {
  GenerateEmbeddingsRequest,
  GenerateEmbeddingsResponse,
  ReloadVectorStoreResponse,
  GetTextEmbeddingRequest,
  GetTextEmbeddingResponse,
  SearchEmbeddingRequest,
  SearchEmbeddingResponse,
  SearchEmbeddingResult,
} from '../models/schemas';
import { logger } from '../utils/logger';
import { QueryTypes } from 'sequelize';

const router = Router();

declare global {
  namespace Express {
    interface Application {
      vectorStore?: VectorStoreService;
    }
  }
}

/**
 * Reload Vector Store Endpoint
 * Verifies PostgreSQL vector store tables and returns record counts.
 */
router.post('/reload-vector-store', async (req: Request, res: Response) => {
  try {
    const vectorStore = req.app.vectorStore;
    if (!vectorStore) {
      return res.status(500).json({
        status: 'error',
        message: 'Vector store not initialized',
      });
    }

    // Reload stores
    await vectorStore.initializeStores();

    // Get counts
    const examplesCount = await VectorExample.count();
    const extraPromptsCount = await VectorExtraPrompt.count();

    const response: ReloadVectorStoreResponse = {
      status: 'success',
      message: 'Vector store reloaded successfully',
      examples_count: examplesCount,
      extra_prompts_count: extraPromptsCount,
    };

    logger.info('📤 Reload Vector Store API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      response: response,
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Reload vector store route error: ${error}`);
    const errorResponse = {
      status: 'error',
      message: error.message || 'Internal server error',
    };
    logger.error('📤 Reload Vector Store API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

/**
 * Generate embeddings for examples table
 */
router.post('/generate-embeddings-examples', async (req: Request, res: Response) => {
  try {
    const payload: GenerateEmbeddingsRequest = req.body;

    const embeddingFieldName = getEmbeddingFieldName();
    const updatedIds: number[] = [];
    const errors: string[] = [];

    if (payload.id) {
      // Generate embedding for specific ID
      // Use raw SQL query to avoid Sequelize model column issues
      try {
        const query = `
          SELECT id, question, sql_query, metadata
          FROM ai_vector_examples
          WHERE id = :id
        `;
        
        const results = await sequelizeReadOnly.query(query, {
          type: QueryTypes.SELECT,
          replacements: { id: payload.id },
        }) as any[];

        if (results.length === 0) {
          return res.status(404).json({
            status: 'error',
            message: `Example with ID ${payload.id} not found`,
          });
        }

        const row = results[0];
        const embeddingText = row.question || '';

        if (!embeddingText.trim()) {
          return res.status(400).json({
            status: 'error',
            message: `Example with ID ${payload.id} has empty question`,
          });
        }

        const embedding = await embedQuery(embeddingText);
        const embeddingStr = '[' + embedding.join(',') + ']';

        await sequelizeUpdate.query(
          `UPDATE ai_vector_examples SET ${embeddingFieldName} = :embedding::vector WHERE id = :id`,
          {
            type: QueryTypes.UPDATE,
            replacements: { embedding: embeddingStr, id: payload.id },
          }
        );

        updatedIds.push(payload.id);
        logger.info(`Generated embedding for example ID: ${payload.id}`);
      } catch (error: any) {
        errors.push(`Error processing ID ${payload.id}: ${error.message}`);
      }
    } else {
      // Generate embeddings for all examples without embeddings
      // Use raw SQL query to avoid Sequelize model column issues
      try {
        const query = `
          SELECT id, question, sql_query, metadata
          FROM ai_vector_examples
          WHERE ${embeddingFieldName} IS NULL
          LIMIT 100
        `;
        
        const results = await sequelizeReadOnly.query(query, {
          type: QueryTypes.SELECT,
        }) as any[];

        if (results.length === 0) {
          return res.json({
            status: 'success',
            message: 'No records to process',
            processed_count: 0,
          });
        }

        for (const row of results) {
          try {
            const recordId = row.id;
            const embeddingText = row.question || '';

            if (!embeddingText.trim()) {
              logger.warn(`Skipping ID ${recordId}: Question is empty`);
              continue;
            }

            const embedding = await embedQuery(embeddingText);
            const embeddingStr = '[' + embedding.join(',') + ']';

            await sequelizeUpdate.query(
              `UPDATE ai_vector_examples SET ${embeddingFieldName} = :embedding::vector WHERE id = :id`,
              {
                type: QueryTypes.UPDATE,
                replacements: { embedding: embeddingStr, id: recordId },
              }
            );

            updatedIds.push(recordId);
            logger.info(`Generated embedding for example ID: ${recordId}`);
          } catch (error: any) {
            errors.push(`Error processing ID ${row.id}: ${error.message}`);
          }
        }
      } catch (error: any) {
        errors.push(`Error fetching examples: ${error.message}`);
      }
    }

    const response: GenerateEmbeddingsResponse = {
      status: updatedIds.length > 0 ? 'success' : 'error',
      message: `Processed ${updatedIds.length} examples`,
      processed_count: updatedIds.length,
      updated_ids: updatedIds,
      errors: errors.length > 0 ? errors : undefined,
    };

    logger.info('📤 Generate Embeddings Examples API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      response: response,
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Generate embeddings route error: ${error}`);
    const errorResponse = {
      status: 'error',
      message: error.message || 'Internal server error',
    };
    logger.error('📤 Generate Embeddings Examples API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

/**
 * Generate embeddings for extra prompts table
 */
router.post('/generate-embeddings-extra-prompts', async (req: Request, res: Response) => {
  try {
    const payload: GenerateEmbeddingsRequest = req.body;

    const embeddingFieldName = getEmbeddingFieldName();
    const updatedIds: number[] = [];
    const errors: string[] = [];

    if (payload.id) {
      // Generate embedding for specific ID
      // Use raw SQL query to avoid Sequelize model column issues
      try {
        const query = `
          SELECT id, content, metadata
          FROM ai_vector_extra_prompts
          WHERE id = :id
        `;
        
        const results = await sequelizeReadOnly.query(query, {
          type: QueryTypes.SELECT,
          replacements: { id: payload.id },
        }) as any[];

        if (results.length === 0) {
          return res.status(404).json({
            status: 'error',
            message: `Extra prompt with ID ${payload.id} not found`,
          });
        }

        const row = results[0];
        const embeddingText = row.content || '';

        if (!embeddingText.trim()) {
          return res.status(400).json({
            status: 'error',
            message: `Extra prompt with ID ${payload.id} has empty content`,
          });
        }

        const embedding = await embedQuery(embeddingText);
        const embeddingStr = '[' + embedding.join(',') + ']';

        await sequelizeUpdate.query(
          `UPDATE ai_vector_extra_prompts SET ${embeddingFieldName} = :embedding::vector WHERE id = :id`,
          {
            type: QueryTypes.UPDATE,
            replacements: { embedding: embeddingStr, id: payload.id },
          }
        );

        updatedIds.push(payload.id);
        logger.info(`Generated embedding for extra prompt ID: ${payload.id}`);
      } catch (error: any) {
        errors.push(`Error processing ID ${payload.id}: ${error.message}`);
      }
    } else {
      // Generate embeddings for all extra prompts without embeddings
      // Use raw SQL query to avoid Sequelize model column issues
      try {
        const query = `
          SELECT id, content, metadata
          FROM ai_vector_extra_prompts
          WHERE ${embeddingFieldName} IS NULL
          LIMIT 100
        `;
        
        const results = await sequelizeReadOnly.query(query, {
          type: QueryTypes.SELECT,
        }) as any[];

        if (results.length === 0) {
          return res.json({
            status: 'success',
            message: 'No records to process',
            processed_count: 0,
          });
        }

        for (const row of results) {
          try {
            const recordId = row.id;
            const embeddingText = row.content || '';

            if (!embeddingText.trim()) {
              logger.warn(`Skipping ID ${recordId}: Content is empty`);
              continue;
            }

            const embedding = await embedQuery(embeddingText);
            const embeddingStr = '[' + embedding.join(',') + ']';

            await sequelizeUpdate.query(
              `UPDATE ai_vector_extra_prompts SET ${embeddingFieldName} = :embedding::vector WHERE id = :id`,
              {
                type: QueryTypes.UPDATE,
                replacements: { embedding: embeddingStr, id: recordId },
              }
            );

            updatedIds.push(recordId);
            logger.info(`Generated embedding for extra prompt ID: ${recordId}`);
          } catch (error: any) {
            errors.push(`Error processing ID ${row.id}: ${error.message}`);
          }
        }
      } catch (error: any) {
        errors.push(`Error fetching extra prompts: ${error.message}`);
      }
    }

    const response: GenerateEmbeddingsResponse = {
      status: updatedIds.length > 0 ? 'success' : 'error',
      message: `Processed ${updatedIds.length} extra prompts`,
      processed_count: updatedIds.length,
      updated_ids: updatedIds,
      errors: errors.length > 0 ? errors : undefined,
    };

    logger.info('📤 Generate Embeddings Extra Prompts API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      response: response,
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Generate embeddings extra prompts route error: ${error}`);
    const errorResponse = {
      status: 'error',
      message: error.message || 'Internal server error',
    };
    logger.error('📤 Generate Embeddings Extra Prompts API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

/**
 * Get embedding for given text
 */
router.post('/get-text-embedding', async (req: Request, res: Response) => {
  try {
    const payload: GetTextEmbeddingRequest = req.body;

    if (!payload.text || !payload.text.trim()) {
      return res.status(400).json({
        status: 'error',
        text: payload.text || '',
        embedding: [],
        embedding_dimension: 0,
      });
    }

    const embedding = await embedQuery(payload.text);

    const response: GetTextEmbeddingResponse = {
      status: 'success',
      text: payload.text,
      embedding: embedding,
      embedding_dimension: embedding.length,
    };

    logger.info('📤 Get Text Embedding API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      responsePreview: {
        status: response.status,
        textLength: response.text.length,
        embedding_dimension: response.embedding_dimension,
      },
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Get text embedding route error: ${error}`);
    const errorResponse = {
      status: 'error',
      text: req.body.text || '',
      embedding: [],
      embedding_dimension: 0,
    };
    logger.error('📤 Get Text Embedding API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

/**
 * Search embedding in PostgreSQL table
 */
router.post('/search-embedding', async (req: Request, res: Response) => {
  try {
    const payload: SearchEmbeddingRequest = req.body;
    const limit = payload.limit || 5;

    if (!payload.text || !payload.text.trim()) {
      return res.status(400).json({
        status: 'error',
        text: payload.text || '',
        limit: limit,
        results: [],
        total_results: 0,
      });
    }

    // Generate embedding from text
    const queryEmbedding = await embedQuery(payload.text);
    const embeddingStr = '[' + queryEmbedding.join(',') + ']';

    const embeddingFieldName = getEmbeddingFieldName();

    // Execute the search query using cosine similarity
    const searchQuery = `
      WITH query AS (
        SELECT
          '${embeddingStr}'::vector
          AS query_embedding
      )
      SELECT
        a.id,
        a.question AS content,
        1 - (a.${embeddingFieldName} <=> q.query_embedding) AS similarity
      FROM public.ai_vector_examples AS a
      CROSS JOIN query AS q
      WHERE a.${embeddingFieldName} IS NOT NULL
      ORDER BY a.${embeddingFieldName} <=> q.query_embedding
      LIMIT :limit
    `;

    const results = await sequelizeReadOnly.query(searchQuery, {
      type: QueryTypes.SELECT,
      replacements: { limit },
    }) as any[];

    // Convert results to SearchEmbeddingResult format
    const searchResults: SearchEmbeddingResult[] = results.map((row) => ({
      id: row.id,
      content: row.content || '',
      similarity: row.similarity ? parseFloat(row.similarity) : 0.0,
    }));

    const response: SearchEmbeddingResponse = {
      status: 'success',
      text: payload.text,
      limit: limit,
      results: searchResults,
      total_results: searchResults.length,
    };

    logger.info('📤 Search Embedding API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      responsePreview: {
        status: response.status,
        text: response.text,
        limit: response.limit,
        total_results: response.total_results,
      },
    });

    return res.json(response);
  } catch (error: any) {
    logger.error(`Search embedding route error: ${error}`);
    const errorResponse = {
      status: 'error',
      text: req.body.text || '',
      limit: req.body.limit || 5,
      results: [],
      total_results: 0,
    };
    logger.error('📤 Search Embedding API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    return res.status(500).json(errorResponse);
  }
});

export default router;
