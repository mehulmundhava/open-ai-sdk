/**
 * Request/Response Schemas
 */

export interface ChatRequest {
  token_id: string;
  question: string;
  user_id?: string;
  login_id?: string;
  chat_history?: Array<[string, string]>;
}

export interface ChatResponse {
  token_id: string;
  answer: string;
  sql_query?: string;
  results?: Record<string, any>;
  cached?: boolean;
  similarity?: number;
  llm_used?: boolean;
  llm_type?: string;
  tokens_saved?: string;
  debug?: Record<string, any>;
  csv_id?: string;
  csv_download_path?: string;
  /** Full URL for CSV download (API_BASE_URL + path). Use this as link href so download hits the server. */
  csv_download_url?: string;
  security_failure_reason?: string;
  security_blocked?: boolean;
  error?: string;
}

export interface VectorSearchRequest {
  question: string;
  search_type?: 'examples' | 'extra_prompts' | 'both';
  k_examples?: number;
  k_extra_prompts?: number;
  example_id?: number;
  extra_prompts_id?: number;
}

export interface VectorSearchResponse {
  status: string;
  question: string;
  search_type: string;
  examples?: Array<{
    id: number;
    content: string;
    distance?: number;
    similarity?: number;
    metadata?: Record<string, any>;
  }>;
  extra_prompts?: Array<{
    id: number;
    content: string;
    distance?: number;
    similarity?: number;
    metadata?: Record<string, any>;
  }>;
  total_results: number;
}

export interface GenerateEmbeddingsRequest {
  id?: number;
}

export interface GenerateEmbeddingsResponse {
  status: string;
  message: string;
  processed_count?: number;
  updated_ids?: number[];
  errors?: string[];
}

export interface HealthCheckResponse {
  status: string;
  database: {
    connected: boolean;
    error?: string;
  };
  llm: {
    available: boolean;
    error?: string;
  };
  timestamp: string;
}

export interface ReloadVectorStoreResponse {
  status: string;
  message: string;
  examples_count?: number;
  extra_prompts_count?: number;
}

export interface GetTextEmbeddingRequest {
  text: string;
}

export interface GetTextEmbeddingResponse {
  status: string;
  text: string;
  embedding: number[];
  embedding_dimension: number;
}

export interface SearchEmbeddingRequest {
  text: string;
  limit?: number;
}

export interface SearchEmbeddingResult {
  id: number;
  content: string;
  similarity: number;
}

export interface SearchEmbeddingResponse {
  status: string;
  text: string;
  limit: number;
  results: SearchEmbeddingResult[];
  total_results: number;
}
