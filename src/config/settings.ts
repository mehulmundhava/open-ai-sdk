import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface Settings {
  // OpenAI Configuration
  openaiApiKey: string;
  
  // Database Configuration - Read-only
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbSslMode: string;
  
  // Database Configuration - Update (optional)
  updateUser?: string;
  updatePassword?: string;
  
  // Embedding Configuration
  embeddingModelName: string;
  
  // Logging Configuration
  logLevel: string;
  logDir: string;
  logRotationIntervalHours: number;
  logRetentionDays: number;
  logToConsole: boolean;
  logToFile: boolean;
  
  // API Configuration
  apiBaseUrl: string;
  port: number;
  
  // Vector Cache Configuration
  vectorCacheEnabled: boolean;
  vectorCacheSimilarityThreshold: number;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] || defaultValue;
  if (!value && !defaultValue) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value!;
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export const settings: Settings = {
  // OpenAI
  openaiApiKey: getEnv('OPENAI_API_KEY'),
  
  // Database - Read-only
  dbHost: getEnv('DB_HOST', 'localhost'),
  dbPort: getEnvNumber('DB_PORT', 5432),
  dbName: getEnv('DB_NAME'),
  dbUser: getEnv('DB_USER') || getEnv('DBUSER', ''),
  dbPassword: getEnv('DB_PASSWORD'),
  dbSslMode: getEnv('DB_SSL_MODE', 'prefer'),
  
  // Database - Update (optional)
  updateUser: process.env.UPDATE_USER,
  updatePassword: process.env.UPDATE_PASSWORD,
  
  // Embeddings
  embeddingModelName: getEnv('EMBEDDING_MODEL_NAME', 'sentence-transformers/all-MiniLM-L6-v2'),
  
  // Logging
  logLevel: getEnv('LOG_LEVEL', 'INFO'),
  logDir: getEnv('LOG_DIR', 'logs'),
  logRotationIntervalHours: getEnvNumber('LOG_ROTATION_INTERVAL_HOURS', 24),
  logRetentionDays: getEnvNumber('LOG_RETENTION_DAYS', 30),
  logToConsole: getEnvBoolean('LOG_TO_CONSOLE', true),
  logToFile: getEnvBoolean('LOG_TO_FILE', true),
  
  // API
  apiBaseUrl: getEnv('API_BASE_URL', 'http://localhost:3009').replace(/\/$/, ''),
  port: getEnvNumber('PORT', 3009),
  
  // Vector Cache
  vectorCacheEnabled: getEnvBoolean('VECTOR_CACHE_ENABLED', true),
  vectorCacheSimilarityThreshold: parseFloat(getEnv('VECTOR_CACHE_SIMILARITY_THRESHOLD', '0.80')),
};

// Validate required settings
if (!settings.openaiApiKey) {
  throw new Error('OPENAI_API_KEY is required');
}

if (!settings.dbName || !settings.dbUser || !settings.dbPassword) {
  throw new Error('Database configuration is incomplete. Required: DB_NAME, DB_USER, DB_PASSWORD');
}

console.log('✅ Configuration loaded successfully');
console.log(`   Database: ${settings.dbHost}:${settings.dbPort}/${settings.dbName}`);
console.log(`   Embedding Model: ${settings.embeddingModelName}`);
console.log(`   Log Level: ${settings.logLevel}`);
