import { settings } from '../config/settings';
import { logger } from '../utils/logger';

let embeddingPipeline: any = null;

/**
 * Initialize the embedding pipeline with Hugging Face model
 */
export async function initializeEmbeddings(): Promise<void> {
  try {
    logger.info(`Initializing Hugging Face embeddings with model: ${settings.embeddingModelName}`);
    
    // Use dynamic import for ES Module - use Function to ensure it's truly dynamic
    // This prevents TypeScript from converting it to require()
    const transformersModule = await new Function('return import("@xenova/transformers")')();
    const { pipeline } = transformersModule;
    
    embeddingPipeline = await pipeline(
      'feature-extraction',
      settings.embeddingModelName,
      {
        quantized: false, // Set to true for smaller models if needed
      }
    );
    
    logger.info('✅ Embeddings pipeline initialized successfully');
  } catch (error) {
    logger.error(`Failed to initialize embeddings: ${error}`);
    throw error;
  }
}

/**
 * Generate embedding vector for a query string
 */
export async function embedQuery(query: string): Promise<number[]> {
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
    logger.error(`Error generating embedding: ${error}`);
    throw error;
  }
}

/**
 * Get embedding dimension based on model
 */
export function getEmbeddingDimension(): number {
  const modelName = settings.embeddingModelName.toLowerCase();
  
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
  const modelName = settings.embeddingModelName.toLowerCase();
  
  if (modelName.includes('bge-large') || modelName.includes('bge_large')) {
    return 'bge_large_embedding';
  } else if (modelName.includes('minilm')) {
    return 'minilm_embedding';
  }
  
  // Default fallback
  return 'minilm_embedding';
}
