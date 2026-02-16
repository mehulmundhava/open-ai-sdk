import { settings } from '../config/settings';
import { logger } from '../utils/logger';
import OpenAI from 'openai';

let embeddingPipeline: any = null;
let openaiClient: OpenAI | null = null;

/**
 * Get cleaned model name (trimmed, quotes removed)
 */
function getCleanedModelName(): string {
  return settings.embeddingModelName.trim().replace(/^["']|["']$/g, '');
}

/**
 * Check if the embedding model is an OpenAI model
 */
function isOpenAIModel(): boolean {
  // Trim and remove quotes if present (dotenv sometimes includes quotes)
  const modelName = getCleanedModelName().toLowerCase();
  return modelName.startsWith('text-embedding');
}

/**
 * Initialize the embedding pipeline (HuggingFace or OpenAI)
 */
export async function initializeEmbeddings(): Promise<void> {
  try {
    // Trim and clean the model name (remove quotes if present)
    const modelName = getCleanedModelName();
    logger.info(`🔍 Checking embedding model: "${modelName}" (original: "${settings.embeddingModelName}")`);
    
    if (isOpenAIModel()) {
      logger.info(`Initializing OpenAI embeddings with model: ${modelName}`);
      openaiClient = new OpenAI({
        apiKey: settings.openaiApiKey,
      });
      logger.info('✅ OpenAI embeddings client initialized successfully');
    } else {
      logger.info(`Initializing Hugging Face embeddings with model: ${modelName}`);
      
      // Use dynamic import for ES Module - use Function to ensure it's truly dynamic
      // This prevents TypeScript from converting it to require()
      const transformersModule = await new Function('return import("@xenova/transformers")')();
      const { pipeline } = transformersModule;
      
      embeddingPipeline = await pipeline(
        'feature-extraction',
        modelName,
        {
          quantized: false, // Set to true for smaller models if needed
        }
      );
      
      logger.info('✅ Hugging Face embeddings pipeline initialized successfully');
    }
  } catch (error) {
    logger.error(`Failed to initialize embeddings: ${error}`);
    throw error;
  }
}

/**
 * Generate embedding vector for a query string
 */
export async function embedQuery(query: string): Promise<number[]> {
  if (isOpenAIModel()) {
    // Use OpenAI API
    if (!openaiClient) {
      await initializeEmbeddings();
    }

    try {
      const modelName = getCleanedModelName();
      const response = await openaiClient!.embeddings.create({
        model: modelName,
        input: query,
      });

      // Log token usage if available
      if (response.usage) {
        logger.info(`📊 OpenAI Embedding Token Usage:`, {
          model: modelName,
          prompt_tokens: response.usage.prompt_tokens,
          total_tokens: response.usage.total_tokens,
          query_length: query.length,
        });
      }

      // OpenAI returns normalized embeddings by default
      const embedding = response.data[0].embedding;
      return embedding;
    } catch (error) {
      logger.error(`Error generating OpenAI embedding: ${error}`);
      throw error;
    }
  } else {
    // Use HuggingFace
    if (!embeddingPipeline) {
      await initializeEmbeddings();
    }

    try {
      // Generate embedding
      const output = await embeddingPipeline!(query, {
        pooling: 'mean',
        normalize: true,
      });

      // Convert to array of numbers
      // The output is typically a tensor, we need to extract the values
      let embedding: number[];
      
      if (Array.isArray(output)) {
        embedding = output.flat() as number[];
      } else if (output && typeof output === 'object' && 'data' in output) {
        // Handle tensor-like objects
        embedding = Array.from(output.data as any);
      } else {
        throw new Error('Unexpected embedding output format');
      }

      // Normalize if needed (some models may not normalize by default)
      const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
      if (magnitude > 0) {
        embedding = embedding.map((val) => val / magnitude);
      }

      return embedding;
    } catch (error) {
      logger.error(`Error generating HuggingFace embedding: ${error}`);
      throw error;
    }
  }
}

/**
 * Get embedding dimension based on model
 */
export function getEmbeddingDimension(): number {
  const modelName = getCleanedModelName().toLowerCase();
  
  // OpenAI models
  if (modelName.includes('text-embedding-3-large')) {
    return 3072; // text-embedding-3-large has 3072 dimensions
  } else if (modelName.includes('text-embedding-3-small')) {
    return 1536; // text-embedding-3-small has 1536 dimensions
  } else if (modelName.startsWith('text-embedding')) {
    // Other OpenAI embedding models (fallback to small dimensions)
    return 1536;
  }
  
  // HuggingFace models
  if (modelName.includes('bge-large') || modelName.includes('bge_large')) {
    return 1024; // BGE-large models typically have 1024 dimensions
  } else if (modelName.includes('minilm')) {
    return 384; // MiniLM models typically have 384 dimensions
  }
  
  // Default fallback
  return 384;
}

/**
 * Get the database field name for embeddings based on the model
 */
export function getEmbeddingFieldName(): string {
  const modelName = getCleanedModelName().toLowerCase();
  
  // OpenAI models
  if (modelName.includes('text-embedding-3-large')) {
    return 'openai_embedding_3_large';
  } else if (modelName.includes('text-embedding-3-small')) {
    return 'openai_embedding_3_small';
  } else if (modelName.startsWith('text-embedding')) {
    // Other OpenAI embedding models (fallback to small)
    return 'openai_embedding_3_small';
  }
  
  // HuggingFace models
  if (modelName.includes('bge-large') || modelName.includes('bge_large')) {
    return 'bge_large_embedding';
  } else if (modelName.includes('minilm')) {
    return 'minilm_embedding';
  }
  
  // Default fallback
  return 'minilm_embedding';
}
