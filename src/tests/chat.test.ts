/**
 * Test case for chat endpoint
 * This test verifies that the chat functionality works correctly
 * and that the OpenAI client initialization error is resolved.
 */

import { processChat } from '../controllers/chatController';
import { VectorStoreService } from '../services/vectorStore';
import { ChatRequest } from '../models/schemas';
import { logger } from '../utils/logger';

// Mock the vector store service
class MockVectorStoreService extends VectorStoreService {
  async initializeStores(): Promise<void> {
    // Mock implementation
  }

  async searchExamples(
    query: string,
    k: number = 5,
    exampleId?: number,
    useDescriptionOnly?: boolean
  ): Promise<any[]> {
    // Return mock examples
    return [
      {
        question: 'How many users are there?',
        sql_query: 'SELECT COUNT(*) FROM users',
        description: 'Count total users',
        similarity: 0.95,
      },
    ];
  }

  async searchExtraPrompts(
    query: string,
    k: number = 5
  ): Promise<any[]> {
    // Return mock prompts
    return [];
  }
}

/**
 * Test chat endpoint with a simple question
 */
export async function testChatEndpoint(): Promise<boolean> {
  try {
    logger.info('🧪 Starting chat endpoint test...');

    // Create mock vector store
    const vectorStore = new MockVectorStoreService();
    await vectorStore.initializeStores();

    // Create test request
    const testRequest: ChatRequest = {
      token_id: 'Test123',
      user_id: 'admin',
      question: 'How many users are in the database?',
      chat_history: [],
    };

    logger.info('📤 Sending test chat request...');
    logger.info(`   Question: ${testRequest.question}`);
    logger.info(`   User ID: ${testRequest.user_id}`);

    // Process the chat request
    const startTime = Date.now();
    const response = await processChat(testRequest, vectorStore);
    const elapsedTime = Date.now() - startTime;

    logger.info('📥 Received chat response');
    logger.info(`   Answer: ${response.answer.substring(0, 100)}...`);
    logger.info(`   LLM Used: ${response.llm_used}`);
    logger.info(`   LLM Type: ${response.llm_type}`);
    logger.info(`   Elapsed Time: ${elapsedTime}ms`);

    // Validate response
    if (!response) {
      logger.error('❌ Test failed: No response received');
      return false;
    }

    if (!response.answer || response.answer.trim().length === 0) {
      logger.error('❌ Test failed: Empty answer received');
      return false;
    }

    if (response.llm_used !== true) {
      logger.error('❌ Test failed: LLM was not used');
      return false;
    }

    if (!response.token_id || response.token_id !== testRequest.token_id) {
      logger.error('❌ Test failed: Token ID mismatch');
      return false;
    }

    logger.info('✅ Chat endpoint test passed!');
    logger.info(`   Response contains answer: ${response.answer.length} characters`);
    if (response.sql_query) {
      logger.info(`   SQL Query generated: ${response.sql_query}`);
    }
    if (response.debug) {
      logger.info(`   Request ID: ${response.debug.request_id}`);
      logger.info(`   Token Usage: ${JSON.stringify(response.debug.token_usage)}`);
    }

    return true;
  } catch (error: any) {
    logger.error(`❌ Test failed with error: ${error.message}`);
    logger.error(`   Stack: ${error.stack}`);
    
    // Check if it's the specific error we're testing for
    if (error.message && error.message.includes('Cannot read properties of null')) {
      logger.error('❌ ERROR NOT RESOLVED: Still getting null client error');
      return false;
    }
    
    if (error.message && error.message.includes('Package subpath')) {
      logger.error('❌ ERROR NOT RESOLVED: Still getting package path error');
      return false;
    }

    // Other errors might be expected (e.g., API key issues, network issues)
    logger.warn('⚠️  Test encountered an error, but it may not be the error we were fixing');
    return false;
  }
}

/**
 * Run the test if this file is executed directly
 */
if (require.main === module) {
  testChatEndpoint()
    .then((success) => {
      if (success) {
        logger.info('✅ All tests passed!');
        process.exit(0);
      } else {
        logger.error('❌ Tests failed!');
        process.exit(1);
      }
    })
    .catch((error) => {
      logger.error(`❌ Test execution failed: ${error}`);
      process.exit(1);
    });
}
