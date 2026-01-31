import { Router, Request, Response } from 'express';
import { testConnections } from '../config/database';
import { HealthCheckResponse } from '../models/schemas';
import { settings } from '../config/settings';
import { logger } from '../utils/logger';

const router = Router();

// Health check handler
async function healthCheckHandler(req: Request, res: Response): Promise<void> {
  const response: HealthCheckResponse = {
    status: 'ok',
    database: {
      connected: false,
    },
    llm: {
      available: false,
    },
    timestamp: new Date().toISOString(),
  };

  // Test database connection
  try {
    await testConnections();
    response.database.connected = true;
  } catch (error: any) {
    response.database.error = error.message;
    logger.error(`Health check - Database error: ${error}`);
  }

  // Test LLM availability
  try {
    // Just check if API key is set (actual API call would be expensive)
    if (settings.openaiApiKey) {
      response.llm.available = true;
    } else {
      response.llm.error = 'OpenAI API key not set';
    }
  } catch (error: any) {
    response.llm.error = error.message;
    logger.error(`Health check - LLM error: ${error}`);
  }

  // Set status based on checks
  if (!response.database.connected || !response.llm.available) {
    response.status = 'degraded';
    logger.info('📤 Health API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 503,
      response: response,
    });
    res.status(503).json(response);
    return;
  }
  
  logger.info('📤 Health API Response:', {
    method: req.method,
    path: req.path,
    statusCode: 200,
    response: response,
  });
  
  res.json(response);
}

// Register route - handles both GET and POST requests
router.get('/', healthCheckHandler);
router.post('/', healthCheckHandler);

export default router;
