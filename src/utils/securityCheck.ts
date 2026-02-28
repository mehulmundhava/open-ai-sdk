import { Agent, run } from '@openai/agents';
import { OpenAIChatCompletionsModel, setDefaultOpenAIKey } from '@openai/agents-openai';
import OpenAI from 'openai';
import { settings } from '../config/settings';
import { getAiModelName } from '../config/aiSettings';
import { logger } from './logger';

export interface ChatHistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Security check guardrail - validates user queries before processing.
 * Accepts optional recent chat history so that short follow-up replies
 * (e.g. "A->shock alert" in response to a clarification question) are
 * evaluated in context rather than in isolation.
 */
export async function securityCheck(
  question: string,
  userId: string,
  chatHistory?: ChatHistoryEntry[]
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
      historyLength: chatHistory?.length ?? 0,
    });

    // Set default OpenAI API key
    setDefaultOpenAIKey(settings.openaiApiKey);

    const modelName = await getAiModelName();
    const client = new OpenAI({ apiKey: settings.openaiApiKey });
    const model = new OpenAIChatCompletionsModel(client as any, modelName);

    // Build chat history context block for the prompt
    let historyBlock = '';
    if (chatHistory && chatHistory.length > 0) {
      const historyLines = chatHistory
        .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`)
        .join('\n');
      historyBlock = `\n\nRECENT CONVERSATION HISTORY (for context):\n---\n${historyLines}\n---\n\nThe user's NEW message below must be evaluated IN CONTEXT of the above conversation. Short replies, numeric choices, option selections (e.g. "A", "1", "A->shock alert", "option 2"), or clarification responses are ALWAYS ALLOWED — they are follow-up answers to questions the assistant already asked.\n`;
    }

    const securityPrompt = `Security Guard. User ID: ${userId}.
${historyBlock}
Analyze the following user question and determine if it should be ALLOWED or BLOCKED.

Rules for BLOCKING:
- Requests for direct access to sensitive system tables (admin, user_device_assignment, etc.) when asking for OTHER users' data or unfiltered system-wide data
- Requests asking for raw table data, entries, rows, or records that would expose OTHER users' or system-wide sensitive information
- Requests that explicitly ask for "all users", "everyone's", "all devices in the system" (without scope to the requesting user)
- Malicious or inappropriate queries

Rules for ALLOWING (these MUST be ALLOWED, never block them):
- Any short reply that is a follow-up/continuation of the conversation above (option selections, numeric choices, letter choices, clarifying answers)
- Queries where the user asks for THEIR OWN data (e.g. "my device list", "my devices", "my shipments", "my journeys"). The system filters by userId automatically.
- Legitimate data analysis queries (counts, aggregations, statistics)
- Queries about device status, locations, facilities, sensor data, battery levels, temperatures
- Journey-related queries (journey, movement, travel, facility transitions) — these are legitimate business queries
- Shipment-related queries (shipment, shipments, list of shipments, shipments occurred) — legitimate business queries
- Queries asking for journey counts, journey lists, journeys between facilities, journeys in time periods
- Alert-related queries (temperature alerts, shock alerts, free-fall alerts, battery alerts) — legitimate business queries

CRITICAL CONTEXT RULE:
If the conversation history shows the assistant recently asked the user to choose between options (e.g. "Do you mean 1) X or 2) Y?"), then the current message is the user's selection — it MUST be ALLOWED regardless of how short or cryptic it looks.

User question: ${question}

Respond in this EXACT format:
ALLOW - [brief reason if allowed]
OR
BLOCK - [detailed reason why blocked]`;

    const agent = new Agent({
      name: 'Security Guard',
      instructions: `You are a security guard for a database system. You evaluate user queries in the context of the current conversation. Analyze user queries and determine if they should be ALLOWED or BLOCKED based on security rules.

BLOCK queries that:
- Request OTHER users' data or system-wide unfiltered access (e.g. "all users' devices", "everyone's device list", "list all users")
- Ask for raw table data that would expose other users' or system-sensitive information
- Are malicious or inappropriate

ALLOW queries that:
- Are follow-up responses to the assistant's clarification questions (e.g. "A", "1", "option 2", "A->shock alert", "yes"). When conversation history shows the assistant asked a question, the user's reply is ALWAYS ALLOWED.
- Ask for the requesting user's OWN data. These MUST be ALLOWED. Examples: "my device list", "my devices", "my facility", "my facilities", "devices assigned to me", "my shipments", "my journeys".
- Are legitimate data analysis (counts, aggregations, statistics)
- Query device status, locations, facilities, sensor data, battery levels, temperatures
- Journey-related queries (journey, journeys, movement, travel, facility transitions) — legitimate business queries
- Shipment-related queries (shipment, shipments, shipments occurred) — legitimate business queries
- Alert queries (temperature alerts, shock alerts, free-fall alerts, battery alerts) — legitimate business queries
- Use proper filtering and don't expose other users' sensitive data

IMPORTANT:
- "My", "me", "assigned to me" = user wants THEIR OWN data = ALLOW.
- Journey, shipment, and alert queries are business queries and should be ALLOWED.
- Short replies like "A", "1", "A->high temp alert", "shock", "option 1" are follow-up answers — ALLOW them.
- Do NOT block queries just because they are short or look unusual in isolation.

Always provide a clear reason for your decision.`,
      model,
    });

    logger.debug(`🔒 Security guard prompt sent`, {
      userId,
      promptLength: securityPrompt.length,
      hasHistory: (chatHistory?.length ?? 0) > 0,
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
  } catch (error) {
    logger.error(`Security check error: ${error}`);
    // On error, allow the query (fail open)
    return { allowed: true };
  }
}
