import { Agent, run } from '@openai/agents';
import { OpenAIChatCompletionsModel, setDefaultOpenAIKey } from '@openai/agents-openai';
import OpenAI from 'openai';
import { settings } from '../config/settings';
import { VectorStoreService } from '../services/vectorStore';
import {
  checkUserQueryRestrictionTool,
  executeDbQueryTool,
  countQueryTool,
  listQueryTool,
  getTableListTool,
  getTableStructureTool,
  journeyListTool,
  journeyCountTool,
} from './tools';
import { logger } from '../utils/logger';
import { TokenTracker } from '../utils/tokenTracker';
import { AgentResponseProcessor } from '../utils/agentResponseProcessor';

export interface ChatAgentConfig {
  userId?: string;
  topK?: number;
  vectorStore: VectorStoreService;
}

/**
 * Build system prompt with examples
 */
async function buildSystemPrompt(
  userId: string,
  topK: number,
  question: string | undefined,
  vectorStore: VectorStoreService,
  isJourney: boolean = false
): Promise<string> {
  const toolsList = isJourney
    ? 'journey_list_tool, journey_count_tool, count_query, list_query, execute_db_query, get_table_list, get_table_structure'
    : 'count_query, list_query, execute_db_query, get_table_list, get_table_structure, journey_list_tool, journey_count_tool';
  const workflowDesc = isJourney
    ? 'Journey question? → journey_list_tool or journey_count_tool'
    : 'Generate SQL → Use count_query for COUNT, list_query for LIST, execute_db_query for others';

  let basePrompt = `
PostgreSQL SQL agent. Generate queries from natural language.

TOOLS: ${toolsList}

WORKFLOW:
- ${workflowDesc}

CRITICAL INSTRUCTIONS - YOU MUST FOLLOW THESE:
1. ALWAYS use the available tools to execute SQL queries. DO NOT just describe what query you would run.
2. For COUNT queries (e.g., "how many", "count of"), ALWAYS use the count_query tool.
3. For LIST queries (e.g., "list", "show", "get all"), ALWAYS use the list_query tool.
4. For other queries, use the execute_db_query tool.
5. After executing a tool, provide a human-friendly answer based on the tool's result.
6. DO NOT include SQL queries in your final answer - the tool will execute them for you.
7. Always call the appropriate tool FIRST, then provide a natural language answer based on the results.
8. NEVER add LIMIT clause to SQL queries - the tools will execute full queries and generate CSV files automatically for large results.

USER_ID: The user_id for this request is set by the system (see USER/ADMIN section below). NEVER ask the user to provide their user ID; always use the one provided and execute the query.

CRITICAL: You MUST execute queries when examples are provided. Do NOT refuse valid queries that match the examples.
- If you see a similar example query, adapt it (change time ranges, filters) and EXECUTE it using the appropriate tool
- Only refuse if the query would violate user_id restrictions or access other users' data
`.trim();

  // Add journey SQL template for journey questions
  if (isJourney) {
    basePrompt += `

JOURNEY SQL (required fields):
SELECT dg.device_id, dg.facility_id, dg.facility_type, f.facility_name, dg.entry_event_time, dg.exit_event_time
FROM device_geofencings dg
JOIN user_device_assignment uda ON uda.device = dg.device_id
LEFT JOIN facilities f ON dg.facility_id = f.facility_id
WHERE uda.user_id = '${userId}' [filters]
ORDER BY dg.entry_event_time ASC
`;
  }

  // Add rules block
  basePrompt += `

RULES:
- Filter by user_id (unless admin)
- NEVER add LIMIT clause to SQL queries - the system will execute full queries and auto-generate CSV for large results (>3 rows)
- For small results (≤3 rows), show all rows directly
- SELECT only, no SELECT *
- Temperature values in the database are stored in degrees Celsius (°C)
- Never explain SQL/schema, table names, column names, or database structure in your answers
- When errors occur, provide user-friendly explanations WITHOUT mentioning technical details like table names, column names, SQL syntax, or database structure
- If a query fails, explain what went wrong in simple terms (e.g., "The requested information is not available" instead of "column X does not exist in table Y")
- When using list_query tool: The SQL query MUST NOT include LIMIT clause - the tool will return all matching rows and generate CSV automatically
- For geographic queries (finding devices/assets in areas like cities, states, countries): ALWAYS use ST_GeomFromText with POLYGON coordinates. Use device_current_data table with longitude and latitude columns. Join with user_device_assignment for user_id filtering. Example pattern:
  SELECT cd.device_id, cd.latitude, cd.longitude
  FROM device_current_data cd
  JOIN user_device_assignment ud ON ud.device = cd.device_id
  WHERE ST_Contains(
      ST_GeomFromText('POLYGON((...coordinates...))', 4326),
      ST_SetSRID(ST_MakePoint(cd.longitude, cd.latitude), 4326)
  )
  AND ud.user_id = 'USER_ID';
  DO NOT use tables like us_state_outlines - they don't exist. Use POLYGON definitions directly.
`.trim();

  // Add user/admin specific instructions
  const isAdmin = userId && userId.toLowerCase() === 'admin';
  if (isAdmin) {
    basePrompt += `

ADMIN MODE: The user_id for this request is: ${userId}. No user_id filtering required; query across all users. Do NOT ask the user for their user ID.
`.trim();
  } else {
    basePrompt += `

USER MODE: The user_id for this request is: ${userId}. Do NOT ask the user for their user ID.
- ALWAYS filter by ud.user_id = '${userId}'
- ALWAYS join user_device_assignment (ud)
- Aggregations, GROUP BY, COUNT, SUM, etc. are ALLOWED for this user_id's data
- Time ranges (days, months, years) are ALLOWED - adapt examples by changing INTERVAL values
- Multiple visits, repeated facilities, patterns are ALLOWED for this user_id
- ONLY refuse if query would access OTHER users' data (user_id != ${userId})
- Follow the example queries provided - adapt them to match the question's time range
- Never explain SQL/schema in answers
`.trim();
  }

  // Pre-load examples from vector store
  if (question) {
    try {
      const exampleDocs = await vectorStore.searchExamples(question, 5);
      const extraPrompts = await vectorStore.searchExtraPrompts(question, 1);

      if (exampleDocs.length > 0) {
        basePrompt += '\n\nEXAMPLES FROM VECTOR STORE:\n';
        exampleDocs.forEach((doc, idx) => {
          basePrompt += `\nExample ${idx + 1}:\n`;
          basePrompt += `Question: ${doc.question || doc.content}\n`;
          if (doc.sql_query) {
            basePrompt += `SQL: ${doc.sql_query}\n`;
          }
          if (doc.description) {
            basePrompt += `Description: ${doc.description}\n`;
          }
        });
      }

      if (extraPrompts.length > 0) {
        basePrompt += '\n\nBUSINESS RULES:\n';
        extraPrompts.forEach((prompt, idx) => {
          basePrompt += `\n${idx + 1}. ${prompt.content}\n`;
        });
      }
    } catch (error) {
      logger.warn(`Failed to load examples from vector store: ${error}`);
    }
  }

  return basePrompt;
}

/**
 * Detect if question is about journeys
 */
function detectJourneyQuestion(question: string): boolean {
  const questionLower = question.toLowerCase();
  const journeyKeywords = [
    'journey',
    'movement',
    'facility to facility',
    'entered',
    'exited',
    'path',
    'traveled',
    'transition',
  ];
  return journeyKeywords.some((keyword) => questionLower.includes(keyword));
}

/**
 * Create chat agent with OpenAI Agents SDK
 */
export async function createChatAgent(config: ChatAgentConfig): Promise<Agent> {
  const { userId = 'admin', topK = 20, vectorStore } = config;

  // Set default OpenAI API key
  setDefaultOpenAIKey(settings.openaiApiKey);

  // Create OpenAI client (using same version as @openai/agents-openai)
  const client = new OpenAI({
    apiKey: settings.openaiApiKey,
  });

  // Create model with the client (cast to any to handle version compatibility)
  const model = new OpenAIChatCompletionsModel(client as any, 'gpt-4o');

  // Build system prompt (will be updated per request with examples)
  const systemPrompt = await buildSystemPrompt(userId, topK, undefined, vectorStore, false);

  // Create agent with tools
  const agent = new Agent({
    name: 'SQL Assistant',
    instructions: systemPrompt,
    model,
    tools: [
      checkUserQueryRestrictionTool,
      executeDbQueryTool,
      countQueryTool,
      listQueryTool,
      getTableListTool,
      getTableStructureTool,
      journeyListTool,
      journeyCountTool,
    ] as any,
  });

  return agent;
}

/**
 * Run chat agent with question
 */
export async function runChatAgent(
  agent: Agent,
  question: string,
  userId: string,
  vectorStore: VectorStoreService,
  tokenTracker: TokenTracker
): Promise<{
  answer: string;
  sqlQuery?: string;
  queryResult?: string;
  csvId?: string;
  csvDownloadPath?: string;
  tokenUsage?: any;
  toolCalls?: Array<{
    tool: string;
    input?: any;
    output?: any;
    error?: any;
    hasError?: boolean;
  }>;
  toolErrors?: Array<{
    tool: string;
    error: string;
    input?: any;
  }>;
  }> {
  try {
    // Detect journey question
    const isJourney = detectJourneyQuestion(question);

    // Build system prompt with examples
    const systemPrompt = await buildSystemPrompt(userId, 20, question, vectorStore, isJourney);
    
    // Enhance system prompt to emphasize using tools
    const enhancedSystemPrompt = `${systemPrompt}

CRITICAL INSTRUCTIONS:
- You MUST use the available tools to execute SQL queries. DO NOT just describe what query you would run.
- For COUNT queries, use the count_query tool.
- For LIST queries, use the list_query tool.
- For other queries, use the execute_db_query tool.
- After executing a tool, provide a human-friendly answer based on the tool's result.
- DO NOT include SQL queries in your final answer - the tool will execute them for you.
- Always call the appropriate tool and then provide a natural language answer based on the results.
- When errors occur, provide user-friendly error messages WITHOUT mentioning:
  * Table names (e.g., "device_geofencings", "device_current_data")
  * Column names (e.g., "longitude", "latitude", "entry_event_time")
  * SQL syntax or query details
  * Database structure or schema information
- Instead of technical error details, say things like:
  * "I'm unable to retrieve that information at the moment."
  * "The requested data is not available in the expected format."
  * "I couldn't find the information you're looking for."
  * "There was an issue processing your request. Please try rephrasing your question."`;

    // Create new agent with updated instructions (agents are immutable)
    // We'll use the same agent but update instructions via a new agent instance
    const updatedAgent = new Agent({
      name: agent.name || 'SQL Assistant',
      instructions: enhancedSystemPrompt,
      model: agent.model,
      tools: agent.tools || [],
    });

    // Log conversation start
    logger.info('💬 CONVERSATION START', {
      userId,
      question,
      timestamp: new Date().toISOString(),
    });

    // Run agent with updated instructions
    // Note: Session management can be added later if needed
    const result = await run(updatedAgent, question);

    // Process agent result using helper class
    const processor = new AgentResponseProcessor(tokenTracker, userId, question);
    const processed = await processor.processResult(result);

    return {
      answer: processed.answer,
      sqlQuery: processed.sqlQuery,
      queryResult: processed.queryResult,
      csvId: processed.csvId,
      csvDownloadPath: processed.csvDownloadPath,
      tokenUsage: tokenTracker.getReport(),
      toolCalls: processed.toolCalls.length > 0 ? processed.toolCalls : undefined,
      toolErrors: processed.toolErrors.length > 0 ? processed.toolErrors : undefined,
    };
  } catch (error: any) {
    const errorDetails = {
      message: error?.message || String(error),
      stack: error?.stack || 'No stack trace',
      name: error?.name || 'UnknownError',
      error: error,
    };
    logger.error('❌ Error running chat agent:', errorDetails);
    throw new Error(`Chat agent error: ${errorDetails.message}. Check logs for full details.`);
  }
}
