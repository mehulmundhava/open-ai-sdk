import { sequelizeReadOnly } from '../config/database';
import { VectorExample, VectorExtraPrompt } from '../models';
import { embedQuery, getEmbeddingFieldName } from './embeddings';
import { settings } from '../config/settings';
import { logger } from '../utils/logger';
import { QueryTypes } from 'sequelize';

export const VECTOR_EXAMPLES_LIMIT = 2;
export const VECTOR_EXTRA_PROMPTS_LIMIT = 1;

export interface VectorSearchResult {
  id: number;
  content: string;
  distance?: number;
  similarity?: number;
  metadata?: Record<string, any>;
  question?: string;
  sql_query?: string;
  description?: string;
  note_type?: string;
}

/**
 * Vector Store Service for PostgreSQL pgvector search
 */
export class VectorStoreService {
  private embeddingFieldName: string;

  constructor() {
    this.embeddingFieldName = getEmbeddingFieldName();
    logger.info(`Using embedding field: ${this.embeddingFieldName}`);
  }

  /**
   * Initialize vector stores - verify tables exist and are accessible
   */
  async initializeStores(): Promise<void> {
    logger.info('Verifying PostgreSQL vector store tables...');

    try {
      const examplesCount = await VectorExample.count();
      logger.info(`✅ Examples table accessible: ${examplesCount} records`);

      const extraPromptsCount = await VectorExtraPrompt.count();
      logger.info(`✅ Extra prompts table accessible: ${extraPromptsCount} records`);

      logger.info('✅ PostgreSQL vector stores initialized successfully');
    } catch (error) {
      logger.error(`Warning: Could not verify vector store tables: ${error}`);
      throw error;
    }
  }

  /**
   * Generate embedding vector for a query string
   */
  async embedQuery(query: string): Promise<number[]> {
    return embedQuery(query);
  }

  /**
   * Search for similar examples in the PostgreSQL vector store
   */
  async searchExamples(
    query: string,
    k: number = VECTOR_EXAMPLES_LIMIT,
    exampleId?: number,
    useDescriptionOnly: boolean = false
  ): Promise<VectorSearchResult[]> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.embedQuery(query);

      // Convert to PostgreSQL array format string for vector type
      const embeddingStr = '[' + queryEmbedding.join(',') + ']';

      // Build WHERE conditions
      const whereConditions: string[] = [`${this.embeddingFieldName} IS NOT NULL`];
      const replacements: Record<string, any> = { k };

      // Add ID filter if provided
      if (exampleId !== undefined) {
        whereConditions.push('id = :exampleId');
        replacements.exampleId = exampleId;
      }

      const whereClause = whereConditions.join(' AND ');

      // Search using pgvector cosine distance
      // Using ORDER BY ... LIMIT for efficient similarity search
      const searchQuery = `
        SELECT 
          id,
          question,
          sql_query,
          description,
          metadata,
          ${this.embeddingFieldName} <-> '${embeddingStr}'::vector AS distance,
          1 - (${this.embeddingFieldName} <-> '${embeddingStr}'::vector) AS similarity
        FROM ai_vector_examples
        WHERE ${whereClause}
        ORDER BY ${this.embeddingFieldName} <-> '${embeddingStr}'::vector
        LIMIT :k
      `;

      const results = await sequelizeReadOnly.query(searchQuery, {
        type: QueryTypes.SELECT,
        replacements,
      }) as any[];

      // Convert to VectorSearchResult format
      return results.map((row) => ({
        id: row.id,
        content: useDescriptionOnly && row.description
          ? row.description
          : `Question: ${row.question}\nSQL: ${row.sql_query}`,
        distance: row.distance,
        similarity: row.similarity,
        metadata: row.metadata || {},
        // Include full data for system prompt
        question: row.question,
        sql_query: row.sql_query,
        description: row.description,
      })) as any;
    } catch (error) {
      logger.error(`Error searching examples: ${error}`);
      throw error;
    }
  }

  /**
   * Search for similar extra prompts in the PostgreSQL vector store
   */
  async searchExtraPrompts(
    query: string,
    k: number = VECTOR_EXTRA_PROMPTS_LIMIT,
    extraPromptId?: number
  ): Promise<VectorSearchResult[]> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.embedQuery(query);

      // Convert to PostgreSQL array format string
      const embeddingStr = '[' + queryEmbedding.join(',') + ']';

      // Build WHERE conditions
      const whereConditions: string[] = [`${this.embeddingFieldName} IS NOT NULL`];
      const replacements: Record<string, any> = { k };

      // Add ID filter if provided
      if (extraPromptId !== undefined) {
        whereConditions.push('id = :extraPromptId');
        replacements.extraPromptId = extraPromptId;
      }

      const whereClause = whereConditions.join(' AND ');

      // Search using pgvector cosine distance
      const searchQuery = `
        SELECT 
          id,
          content,
          note_type,
          metadata,
          ${this.embeddingFieldName} <-> '${embeddingStr}'::vector AS distance,
          1 - (${this.embeddingFieldName} <-> '${embeddingStr}'::vector) AS similarity
        FROM ai_vector_extra_prompts
        WHERE ${whereClause}
        ORDER BY ${this.embeddingFieldName} <-> '${embeddingStr}'::vector
        LIMIT :k
      `;

      const results = await sequelizeReadOnly.query(searchQuery, {
        type: QueryTypes.SELECT,
        replacements,
      }) as any[];

      // Convert to VectorSearchResult format
      return results.map((row) => ({
        id: row.id,
        content: row.content,
        distance: row.distance,
        similarity: row.similarity,
        metadata: row.metadata || {},
        note_type: row.note_type,
      }));
    } catch (error) {
      logger.error(`Error searching extra prompts: ${error}`);
      throw error;
    }
  }
}
