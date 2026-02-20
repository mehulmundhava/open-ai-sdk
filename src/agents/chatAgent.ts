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
  getAreaBoundsTool,
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
 * Build static system prompt prefix (cached content)
 * This content is static and will be cached by OpenAI
 */
function buildStaticPromptPrefix(isJourney: boolean = false): string {
  const toolsList = isJourney
    ? 'journey_list_tool, journey_count_tool, count_query, list_query, execute_db_query, get_table_list, get_table_structure, get_area_bounds'
    : 'count_query, list_query, execute_db_query, get_table_list, get_table_structure, journey_list_tool, journey_count_tool, get_area_bounds';
  const workflowDesc = isJourney
    ? 'Journey question? → journey_list_tool or journey_count_tool'
    : 'Generate SQL → Use count_query for COUNT, list_query for LIST, execute_db_query for others';

  // Build comprehensive static knowledge base to exceed 1024 tokens
  const staticPrompt = `
PostgreSQL SQL Agent - Knowledge Base and Instructions
======================================================

You are an expert PostgreSQL SQL agent designed to generate and execute SQL queries from natural language questions. Your primary responsibility is to understand user intent, generate appropriate SQL queries, execute them using the available tools, and provide human-friendly answers based on the results.

AVAILABLE TOOLS:
${toolsList}

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
8. NEVER add LIMIT clause to SQL queries - the tools will execute full queries and generate CSV files automatically for large results (>3 rows).

DATABASE KNOWLEDGE BASE:
========================

Table Relationships and Structure:
- device_details_table (D): Contains device information like device_name, grai_id, IMEI number. Has current data IDs pointing to latest records in other tables.
- user_device_assignment (UD): Maps users to devices. Always join this table for user_id filtering unless user is admin.
- device_geofencings (DG): Contains device movement data with facility entry/exit times. Does NOT have latitude/longitude columns.
- facilities (F): Contains facility information including latitude and longitude coordinates. Join with device_geofencings using facility_id.
- device_current_data (CD): Contains current/latest snapshot of device data including temperature, battery, location.
- incoming_message_history_k (IK): Contains historical location and sensor data with timestamps.
- sensor (S): Contains sensor data history for temperature and battery.
- shock_info: Contains shock and free-fall event data.

Important Field Notes:
- Temperature values are stored in degrees Celsius (°C)
- device_geofencings table does NOT have latitude/longitude fields - use facilities table for coordinates
- Dwell time is stored in seconds (1 day = 86400 seconds)
- Facility types: M (manufacturer), R (retailer), U, D, etc.

Geographic Query Patterns:
- For device_current_data queries: Use cd.longitude and cd.latitude
- For journey/geofencing queries: JOIN facilities table and use f.longitude and f.latitude
- Always use ST_GeomFromText with POLYGON or MULTIPOLYGON coordinates for geographic filtering
- The get_area_bounds tool may return MULTIPOLYGON for locations with multiple disconnected areas (e.g., countries with islands like Mexico)
- NEVER use placeholder text like "...coordinates..." - ALWAYS use actual numeric coordinates

Geographic Boundary Tool (get_area_bounds):
- When user asks about a specific location (city, state, country, region), FIRST call get_area_bounds tool with STRUCTURED parameters
- CRITICAL: Use proper parameter keys based on location type:
  * For COUNTRIES: use { country: "United States" } or { country: "Mexico" }
  * For STATES/PROVINCES: use { state: "California" } or { state: "Texas" }
  * For CITIES: use { city: "New York" } or { city: "Los Angeles" }
  * For GENERAL queries: use { q: "location name" } only as fallback
  * You can combine: { country: "United States", state: "California" }
- Examples:
  * "devices in United States" → get_area_bounds({ country: "United States" })
  * "shipments in California" → get_area_bounds({ state: "California" })
  * "facilities in New York" → get_area_bounds({ city: "New York" }) or { state: "New York" }
  * "journeys in Mexico" → get_area_bounds({ country: "Mexico" })
- The tool returns JSON with polygon.postgres_format field which may be POLYGON or MULTIPOLYGON format - use this directly in SQL queries
- For locations with multiple disconnected areas (e.g., Mexico with mainland and islands), the tool returns MULTIPOLYGON which includes all regions for accurate results
- If the tool fails, try using the known coordinates below, or inform the user that the area boundary could not be determined
- NEVER generate POLYGON/MULTIPOLYGON coordinates yourself unless the tool fails - always try the tool first with proper parameters

Geographic Coordinate Reference (fallback if get_area_bounds fails):
- Mexico bounding box: POLYGON((-118.4 14.5, -86.8 14.5, -86.8 32.7, -118.4 32.7, -118.4 14.5))
- United States bounding box: POLYGON((-124.848974 49.384358, -66.93457 49.384358, -66.93457 24.396308, -124.848974 24.396308, -124.848974 49.384358))
- India bounding box: POLYGON((66.782749 8.047059, 97.402624 8.047059, 97.402624 37.090353, 66.782749 37.090353, 66.782749 8.047059))
- New York approximate: POLYGON((-74.25909 40.917577, -73.950000 40.800000, -73.700272 40.477399, -74.25909 40.477399, -74.25909 40.917577))

Journey Calculation Rules:
- Journey = device movement from one facility_id to another
- Journey calculations use specialized tools (journey_list_tool, journey_count_tool)
- These tools execute SQL to fetch geofencing rows, then run algorithm to calculate journeys
- Journey time must be >= 4 hours (14400 seconds) between different facilities
- For same facility (A -> A), minimum time is 4 hours + extraJourneyTimeLimit (if provided)

SQL Query Best Practices:
- Always filter by user_id using user_device_assignment table unless user is admin
- SELECT only specific columns needed, never use SELECT *
- For journey queries with geographic filters, include useful fields: device_id, device_name, facility_id, facility_name, facility_type, entry_event_time, exit_event_time, latitude, longitude
- When joining device_geofencings with facilities for coordinates: LEFT JOIN facilities f ON f.facility_id = dg.facility_id
- Use ST_Contains with ST_MakePoint(f.longitude, f.latitude) for geographic filtering on journeys

Error Handling Guidelines:
- Never explain SQL/schema, table names, column names, or database structure in your answers
- When errors occur, provide user-friendly explanations WITHOUT mentioning technical details
- Instead of technical error details, say: "I'm unable to retrieve that information at the moment" or "The requested data is not available in the expected format"

CRITICAL: You MUST execute queries when examples are provided. Do NOT refuse valid queries that match the examples.
- If you see a similar example query, adapt it (change time ranges, filters) and EXECUTE it using the appropriate tool
- Only refuse if the query would violate user_id restrictions or access other users' data
`.trim();

  // Add journey-specific static content
  if (isJourney) {
    return staticPrompt + `

JOURNEY-SPECIFIC INSTRUCTIONS:
==============================

Journey SQL Template (required fields):
SELECT dg.device_id, dg.facility_id, dg.facility_type, f.facility_name, dg.entry_event_time, dg.exit_event_time
FROM device_geofencings dg
JOIN user_device_assignment uda ON uda.device = dg.device_id
LEFT JOIN facilities f ON dg.facility_id = f.facility_id
WHERE uda.user_id = '[USER_ID]' [filters]
ORDER BY dg.entry_event_time ASC

CRITICAL: device_geofencings table does NOT have latitude/longitude fields. For geographic filtering on journeys:
- You MUST JOIN facilities table: LEFT JOIN facilities f ON f.facility_id = dg.facility_id
- Use facilities.latitude and facilities.longitude (NOT device_geofencings - these columns don't exist)
- For geographic ST_Contains filter, use: ST_MakePoint(f.longitude, f.latitude)
- IMPORTANT: If user mentions a location, FIRST call get_area_bounds with STRUCTURED parameters:
  * Countries: get_area_bounds({ country: "United States" })
  * States: get_area_bounds({ state: "California" })
  * Cities: get_area_bounds({ city: "New York" })
- Parse the JSON response and extract polygon.postgres_format field (may be POLYGON or MULTIPOLYGON format)
- Example with geographic filter (using POLYGON or MULTIPOLYGON from get_area_bounds tool):
  WHERE ST_Contains(
      ST_GeomFromText('POLYGON((...))', 4326),  -- or MULTIPOLYGON(((...)), ((...))) - Use polygon.postgres_format from get_area_bounds tool response
      ST_SetSRID(ST_MakePoint(f.longitude, f.latitude), 4326)
  )
`;
  }

  return staticPrompt;
}

/**
 * Build dynamic prompt sections (RAG content and user-specific)
 */
async function buildDynamicPromptSections(
  userId: string,
  question: string | undefined,
  vectorStore: VectorStoreService,
  isJourney: boolean
): Promise<string> {
  let dynamicContent = '';

  // Add user/admin specific instructions (semi-static but user-specific)
  const isAdmin = userId && userId.toLowerCase() === 'admin';
  if (isAdmin) {
    dynamicContent += `

ADMIN MODE: The user_id for this request is: ${userId}. No user_id filtering required; query across all users. Do NOT ask the user for their user ID.
`;
  } else {
    dynamicContent += `

USER MODE: The user_id for this request is: ${userId}. Do NOT ask the user for their user ID.
- ALWAYS filter by ud.user_id = '${userId}'
- ALWAYS join user_device_assignment (ud)
- CRITICAL JOIN INSTRUCTION: user_device_assignment table has a field called "device" (NOT "device_id")
  - Other tables (device_current_data, device_geofencings, etc.) have "device_id" field
  - CORRECT join: JOIN user_device_assignment ud ON ud.device = other_table.device_id
  - WRONG join: JOIN user_device_assignment ud ON ud.device_id = other_table.device_id (DO NOT use this)
  - Example: JOIN user_device_assignment ud ON ud.device = cd.device_id (for device_current_data)
- Aggregations, GROUP BY, COUNT, SUM, etc. are ALLOWED for this user_id's data
- Time ranges (days, months, years) are ALLOWED - adapt examples by changing INTERVAL values
- Multiple visits, repeated facilities, patterns are ALLOWED for this user_id
- ONLY refuse if query would access OTHER users' data (user_id != ${userId})
- Follow the example queries provided - adapt them to match the question's time range
- Never explain SQL/schema in answers
`;
  }

  // Add RAG content (examples and business rules from vector store)
  if (question) {
    try {
      const exampleDocs = await vectorStore.searchExamples(question, 10);
      const extraPrompts = await vectorStore.searchExtraPrompts(question, 1);

      if (exampleDocs.length > 0) {
        dynamicContent += '\n\nEXAMPLES FROM VECTOR STORE:\n';
        exampleDocs.forEach((doc, idx) => {
          dynamicContent += `\nExample ${idx + 1}:\n`;
          dynamicContent += `Question: ${doc.question || doc.content}\n`;
          if (doc.sql_query) {
            dynamicContent += `SQL: ${doc.sql_query}\n`;
          }
          if (doc.description) {
            dynamicContent += `Description: ${doc.description}\n`;
          }
        });
      }

      if (extraPrompts.length > 0) {
        dynamicContent += '\n\nBUSINESS RULES:\n';
        extraPrompts.forEach((prompt, idx) => {
          dynamicContent += `\n${idx + 1}. ${prompt.content}\n`;
        });
      }
    } catch (error) {
      logger.warn(`Failed to load examples from vector store: ${error}`);
    }
  }

  return dynamicContent;
}

/**
 * Build complete system prompt (for backward compatibility)
 */
async function buildSystemPrompt(
  userId: string,
  topK: number,
  question: string | undefined,
  vectorStore: VectorStoreService,
  isJourney: boolean = false,
  includeStaticContent: boolean = true
): Promise<{ staticPrefix: string; dynamicSections: string }> {
  // Only include static content on first message
  const staticPrefix = includeStaticContent ? buildStaticPromptPrefix(isJourney) : '';
  const dynamicSections = await buildDynamicPromptSections(userId, question, vectorStore, isJourney);
  
  return {
    staticPrefix,
    dynamicSections,
  };
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
  // Note: prompt_cache_key will be set per request in runChatAgent
  const model = new OpenAIChatCompletionsModel(client as any, 'gpt-4o');

  // Create agent with tools (instructions will be set per request for caching)
  const agent = new Agent({
    name: 'SQL Assistant',
    instructions: '', // Will be set per request
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
      getAreaBoundsTool,
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
  tokenTracker: TokenTracker,
  conversationId?: string,
  isFirstMessage: boolean = true
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

    // Build prompt with separated static and dynamic sections
    // Only include static content on first message
    const { staticPrefix, dynamicSections } = await buildSystemPrompt(
      userId, 
      20, 
      question, 
      vectorStore, 
      isJourney,
      isFirstMessage
    );
    
    // Construct final system prompt: Static (cached) + Dynamic (RAG) + User question
    // The static prefix will be cached, dynamic sections change per request
    // On subsequent messages, staticPrefix will be empty
    const finalSystemPrompt = isFirstMessage 
      ? staticPrefix + dynamicSections 
      : dynamicSections;

    // Determine prompt cache key based on question type
    const promptCacheKey = isJourney ? 'sql_assistant_journey_v1' : 'sql_assistant_v1';

    // Create new agent with final instructions
    const updatedAgent = new Agent({
      name: agent.name || 'SQL Assistant',
      instructions: finalSystemPrompt,
      model: agent.model,
      tools: agent.tools || [],
    });

    // Log conversation start with cache key
    logger.info('💬 CONVERSATION START', {
      userId,
      conversationId,
      isFirstMessage,
      question,
      isJourney,
      promptCacheKey,
      timestamp: new Date().toISOString(),
    });

    // Run agent with prompt caching
    // OpenAI's prompt caching works by caching the static prefix (first part of system message)
    // The static prefix (buildStaticPromptPrefix) is >= 1024 tokens and will be automatically cached
    // The prompt_cache_key helps identify which cache to use, but caching works automatically
    // when the same static prefix is used across requests
    
    // Log cache key for monitoring (actual caching happens automatically by OpenAI)
    logger.info('📦 Prompt Cache Configuration', {
      promptCacheKey,
      staticPrefixLength: isFirstMessage ? staticPrefix.length : 0,
      estimatedTokens: isFirstMessage ? Math.ceil(staticPrefix.length / 4) : 0, // Rough estimate: ~4 chars per token
      isJourney,
      isFirstMessage,
      conversationId,
    });

    // Run the agent
    // Note: Conversation history is managed by OpenAI's API automatically when using the same conversationId
    // The model will maintain context across requests when using the same agent instance
    // For now, we rely on the model's built-in conversation management
    // The static prefix in the system prompt will be cached by OpenAI automatically
    // when it's >= 1024 tokens and matches previous requests
    const result = await run(updatedAgent, question);

    // Extract usage data (cast to any to access usage property that exists at runtime)
    const resultAny = result as any;
    const usage = resultAny.usage;

    if (usage) {
      const tokenMetrics = {
        total: usage.total_tokens,
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        
        // CACHE INFO (Inside prompt_tokens_details)
        cacheHitTokens: usage.prompt_tokens_details?.cached_tokens || 0,
        
        // REASONING INFO (Inside completion_tokens_details - for o1/o3 models)
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0
      };

      logger.info('📊 TOKEN USAGE REPORT-----', tokenMetrics);
    }

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
