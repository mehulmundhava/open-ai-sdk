import { Agent, run } from '@openai/agents';
import { OpenAIChatCompletionsModel, setDefaultOpenAIKey } from '@openai/agents-openai';
import OpenAI from 'openai';
import { settings } from '../config/settings';
import { logger } from './logger';

/**
 * Security check guardrail - validates user queries before processing
 */
export async function securityCheck(
  question: string,
  userId: string
): Promise<{ allowed: boolean; reason?: string }> {
  // Admin users bypass security check
  if (userId && userId.toLowerCase() === 'admin') {
    return { allowed: true };
  }

  try {
    logger.info(`🔒 Security check initiated`, {
      userId,
      question,
      questionLength: question.length,
    });

    // Set default OpenAI API key
    setDefaultOpenAIKey(settings.openaiApiKey);

    // Create OpenAI client (using same version as @openai/agents-openai)
    const client = new OpenAI({
      apiKey: settings.openaiApiKey,
    });

    // Create model with the client (cast to any to handle version compatibility)
    const model = new OpenAIChatCompletionsModel(client as any, 'gpt-4o');

    const securityPrompt = `Security Guard. User ID: ${userId}. 

Analyze the following user question and determine if it should be ALLOWED or BLOCKED.

Rules for BLOCKING:
- Requests for direct access to sensitive system tables (admin, user_device_assignment, etc.)
- Requests asking for raw table data, entries, rows, or records from sensitive tables
- Requests that could expose sensitive user or system information
- Malicious or inappropriate queries

Rules for ALLOWING:
- Legitimate data analysis queries (counts, aggregations, statistics)
- Queries about device status, locations, facilities
- Queries about sensor data, battery levels, temperatures
- Journey-related queries (e.g., "journey", "journeys", "movement", "travel", "facility transitions") - these are legitimate business queries
- Shipment-related queries (e.g., "shipment", "shipments", "list of shipments", "shipments occurred") - these are legitimate business queries about device movements
- Queries asking for journey counts, journey lists, journeys between facilities, journeys in time periods
- Queries asking for shipment lists, shipment counts, shipments in time periods or locations
- Queries that use proper filtering and don't expose sensitive data
- Queries that are related to current chat previous messages information

IMPORTANT: 
- Journey queries are business queries about device movement patterns and facility transitions. They are processed by specialized journey calculation tools. These queries should be ALLOWED.
- Shipment queries are business queries about device shipments and movements. They are processed by specialized journey calculation tools. These queries should be ALLOWED.
- Queries asking for "list of shipments" or "shipments occurred" are legitimate business queries and should be ALLOWED.

User question: ${question}

Respond in this EXACT format:
ALLOW - [brief reason if allowed]
OR
BLOCK - [detailed reason why blocked]`;

    // Use run function instead
    const agent = new Agent({
      name: 'Security Guard',
      instructions: `You are a security guard for a database system. Analyze user queries and determine if they should be ALLOWED or BLOCKED based on security rules.

BLOCK queries that:
- Request direct access to sensitive system tables
- Ask for raw table data, entries, rows from sensitive tables
- Could expose sensitive user or system information
- Are malicious or inappropriate

ALLOW queries that:
- Are legitimate data analysis (counts, aggregations, statistics)
- Query device status, locations, facilities
- Query sensor data, battery levels, temperatures
- Journey-related queries (journey, journeys, movement, travel, facility transitions) - these are legitimate business queries
- Shipment-related queries (shipment, shipments, list of shipments, shipments occurred) - these are legitimate business queries about device movements
- Queries asking for journey counts, journey lists, journeys between facilities, journeys in time periods
- Queries asking for shipment lists, shipment counts, shipments in time periods or locations
- Use proper filtering and don't expose sensitive data

IMPORTANT: 
- Journey queries are business queries about device movement patterns and facility transitions. They are processed by specialized journey calculation tools. These queries should be ALLOWED.
- Shipment queries are business queries about device shipments and movements. They are processed by specialized journey calculation tools. These queries should be ALLOWED.
- Queries asking for "list of shipments" or "shipments occurred" are legitimate business queries and should be ALLOWED.
- Do NOT block queries just because they ask for a "list" - if they are about journeys or shipments, they are legitimate business queries.
- Queries that are related to current chat previous messages information are ALLOWED.

Always provide a clear reason for your decision.`,
      model,
    });
    
    logger.debug(`🔒 Security guard prompt sent`, {
      userId,
      promptLength: securityPrompt.length,
    });

    const runResult = await run(agent, securityPrompt);
    const responseText = runResult.finalOutput || '';

    logger.debug(`🔒 Security guard response received`, {
      userId,
      responseLength: responseText.length,
      responsePreview: responseText.substring(0, 200),
      fullResponse: responseText,
    });

    // Parse the response to extract decision and reason
    const responseUpper = responseText.trim().toUpperCase();
    const isAllowed = responseUpper.startsWith('ALLOW');
    const isBlocked = responseUpper.startsWith('BLOCK');
    
    let reason: string | undefined;
    
    if (isBlocked) {
      // Extract reason after "BLOCK -"
      const reasonMatch = responseText.match(/BLOCK\s*-\s*(.+)/i);
      reason = reasonMatch ? reasonMatch[1].trim() : 'Query blocked by security guard - no reason provided';
      
      logger.warn(`🔒 Security check BLOCKED query for user ${userId}`, {
        question,
        reason,
        fullResponse: responseText,
      });
      
      return {
        allowed: false,
        reason: reason,
      };
    } else if (isAllowed) {
      // Extract reason after "ALLOW -" if provided
      const reasonMatch = responseText.match(/ALLOW\s*-\s*(.+)/i);
      reason = reasonMatch ? reasonMatch[1].trim() : 'Query allowed by security guard';
      
      logger.info(`✅ Security check ALLOWED query for user ${userId}`, {
        question,
        reason,
      });
      
      return { allowed: true, reason };
    } else {
      // If response format is unexpected, log and allow (fail open)
      logger.warn(`⚠️  Security check returned unexpected response format`, {
        userId,
        question,
        response: responseText,
      });
      return { allowed: true, reason: 'Security check returned unexpected format - allowing by default' };
    }

    return { allowed: true };
  } catch (error) {
    logger.error(`Security check error: ${error}`);
    // On error, allow the query (fail open) - you may want to change this to fail closed
    return { allowed: true };
  }
}
