import express, { Express, Request, Response, NextFunction } from 'express';
import { testConnections } from './config/database';
import { VectorStoreService } from './services/vectorStore';
import { initializeEmbeddings } from './services/embeddings';
import { logger } from './utils/logger';
import { settings } from './config/settings';
// Import models to ensure they are initialized
import './models';

// Import routes
import chatRouter from './routes/chat';
import vectorSearchRouter from './routes/vectorSearch';
import embeddingsRouter from './routes/embeddings';
import csvDownloadRouter from './routes/csvDownload';
import healthRouter from './routes/health';
import aiChatRouter from './routes/aiChat';

const app: Express = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  logger.info(`${req.method} ${req.path}`);
  next();
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error(`Error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// Initialize services
let vectorStore: VectorStoreService;

async function initializeServices() {
  try {
    logger.info('Initializing services...');

    // Test database connections
    await testConnections();
    logger.info('✅ Database connections established');

    // Initialize embeddings
    await initializeEmbeddings();
    logger.info('✅ Embeddings initialized');

    // Initialize vector store
    vectorStore = new VectorStoreService();
    await vectorStore.initializeStores();
    logger.info('✅ Vector store initialized');

    // Store vector store in app state
    app.vectorStore = vectorStore;

    logger.info('✅ All services initialized successfully');
  } catch (error: any) {
    logger.error(`Failed to initialize services: ${error}`);
    throw error;
  }
}

// Register routes
app.use('/health', healthRouter);
app.use('/chat', chatRouter);
app.use('/vector-search', vectorSearchRouter);
app.use('/', embeddingsRouter); // Embeddings routes are at root level (e.g., /reload-vector-store, /generate-embeddings-examples)
app.use('/download-csv', csvDownloadRouter);
app.use('/ai-chat', aiChatRouter);

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    message: 'OpenAI Agents SDK API',
    version: '1.0.0',
    endpoints: {
      chat: '/chat',
      vectorSearch: '/vector-search',
      reloadVectorStore: '/reload-vector-store',
      generateEmbeddingsExamples: '/generate-embeddings-examples',
      generateEmbeddingsExtraPrompts: '/generate-embeddings-extra-prompts',
      getTextEmbedding: '/get-text-embedding',
      searchEmbedding: '/search-embedding',
      downloadCSV: '/download-csv/:csvId',
      health: '/health',
      aiChat: '/ai-chat',
    },
  });
});

// Start server
async function startServer() {
  try {
    // Initialize services
    await initializeServices();

    // Start listening
    const port = settings.port;
    app.listen(port, () => {
      logger.info(`🚀 Server running on port ${port}`);
      logger.info(`   API Base URL: ${settings.apiBaseUrl}`);
      logger.info(`   Health Check: ${settings.apiBaseUrl}/health`);
    });
  } catch (error: any) {
    logger.error(`Failed to start server: ${error}`);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// Start the server
if (require.main === module) {
  startServer();
}

export default app;
