import { Agent, AgentInputItem, run } from '@openai/agents';
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
  getTablesImportantFieldsTool,
  getTableStructureTool,
  journeyListTool,
  journeyCountTool,
  getAreaBoundsTool,
} from './tools';
import { logger } from '../utils/logger';
import { TokenTracker } from '../utils/tokenTracker';
import { AgentResponseProcessor } from '../utils/agentResponseProcessor';
import { AiChat } from '../models/AiChat';
import { AiChatMessage } from '../models/AiChatMessage';

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
    ? 'journey_list_tool, journey_count_tool, count_query, list_query, execute_db_query, get_table_list, get_tables_important_fields, get_table_structure, get_area_bounds'
    : 'count_query, list_query, execute_db_query, get_table_list, get_tables_important_fields, get_table_structure, journey_list_tool, journey_count_tool, get_area_bounds';
  const workflowDesc = isJourney
    ? 'Journey between facilities question? → journey_list_tool or journey_count_tool'
    : 'Generate SQL → Use count_query for COUNT, list_query for LIST, execute_db_query for others';

  // Build comprehensive static knowledge base to exceed 1024 tokens
  const staticPrompt = `
    PostgreSQL SQL Agent - Knowledge Base and Instructions
    ======================================================

    You are an expert PostgreSQL SQL agent designed to generate and execute SQL queries from natural language questions. Your primary responsibility is to understand user intent, generate appropriate SQL queries, execute them using the available tools, and provide human-friendly answers based on the results.

    AVAILABLE TOOLS:
    ${toolsList}

    Table tools (get_table_list, get_tables_important_fields, get_table_structure):
    - ALWAYS call get_table_list first to get available tables (name, description).
    - Call get_tables_important_fields with a list of table names when you want more detail (important fields) for selected tables.
    - Call get_table_structure when you need full column structure (names, types, nullable, defaults) for query generation.

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
    - device_details_table (D): Contains device information like device_id,device_name, grai_id, imei, iccid, imsi. Has current data IDs pointing to latest records in other tables.
    - user_device_assignment (UD): Maps users to devices. Always join this table for user_id filtering unless user is admin. contains user_id and device field. device field is a foreign key to all other tables device_id.
    - device_geofencings (DG): Contains device movement data with facility entry/exit times. Does NOT have latitude/longitude columns.
    - facilities (F): Contains facility information including latitude and longitude coordinates. Join with device_geofencings using facility_id. table has facility_id,facility_name,facility_type,latitude,longitude,street,city,state,zip_code,company_id.
    - device_current_data (CD): Contains current/latest snapshot of device data including temperature, battery, longitude, latitude,dwell_time_seconds,facility_id,facility_type,event_time (location time),shock_event_time,free_fall_event_time.
    - incoming_message_history_k (IK): Contains historical location and sensor data with timestamps,event_time,latitude,longitude,temperature,battery,facility_id,facility_type,dwell_timestamp (integer-seconds),accuracy.
    - sensor (S): Contains sensor data history for temperature, battery, event_time.
    - shock_info: Contains shock and free-fall event data with time_stamp(event time) and type(shock,free_fall).
    - device_temperature_alert: Contains temperature alert history with device_id,start_time,end_time,type(0=min,1=max),threshold_value(min or max allowed value),threshold_duration( minimum duration in seconds),status(0=inactive,1=active).
    - area_bounds (ab): Stores geographic boundaries (polygon/multipolygon) for locations. Populated by get_area_bounds tool. Has id (PRIMARY KEY), area_name, boundary (geometry). For geographic filtering use the area_bound_id returned by get_area_bounds: JOIN area_bounds ab ON ab.id = <area_bound_id> and WHERE ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)).

    Device alerts and thresholds:
    - device_alerts: Stores the last generated alert event per device for min-temperature, max-temperature, battery, and light. One row per device_id with latest alert values and event times. Use to get "last alert" for min-temp (min_temperature, min_temperature_event_time), max-temp (max_temperature, max_temperature_event_time), battery (battery, battery_event_time). These values are the last triggered alert readings; compare with device threshold (from device_settings_data or device_settings_history) to understand alert vs threshold. Join with user_device_assignment for user filtering.
    - device_settings_data: Current threshold values per device. One row per device_id. Fields: ltth (low temperature threshold), htth (high temperature threshold), ltdth (low temp duration threshold), htdth (high temp duration threshold), lbth (low battery threshold), hdth (high dwell time threshold). Use when you need the current/active threshold values for a device (e.g. "current min/max temp threshold", "current battery threshold").
    - device_settings_history: History of device threshold changes. Each row is a threshold change: name (e.g. ltth, htth, ltdth, htdth, lbth, hdth), value, start_time, end_time, value_type (real, integer, string). Use to get what thresholds were active at a given time. Alert history can be derived by comparing sensor data (e.g. sensor table) with device_settings_history: for a time range, use the threshold that was active in that period (start_time <= t < end_time) and match against sensor readings to determine when alerts would have been generated.

    CRITICAL - Queries that ask for "devices that reported X alert in last N period" (or in a date range):
    - You MUST add a JOIN to an alert table and filter by the time window. Do NOT return only devices in a location without filtering by alert; the result must be devices that both (1) match location/user and (2) had the specified alert in the given period.
    - High temperature alert = max temperature (type 1 or max_temperature_event_time). Low temperature alert = min temperature (type 0 or min_temperature_event_time). Battery alert = battery (battery_event_time).
    - Two ways to implement:
      (1) device_alerts (simpler, "last alert in window"): Join device_alerts. Filter by event time in window, e.g. for "high temp alert in last 1 day": JOIN device_alerts da ON da.device_id = cd.device_id WHERE da.max_temperature_event_time >= NOW() - INTERVAL '1 day'. For low temp use min_temperature_event_time; for battery use battery_event_time.
      (2) device_temperature_alert (accurate, "any alert overlapping window"): Join device_temperature_alert. type: 0 = min temp, 1 = max (high) temp. For "alert in last 1 day" require the alert interval to overlap the window: window_start = NOW() - INTERVAL '1 day', window_end = NOW(); use WHERE dta.type = 1 (for high) AND dta.start_time <= window_end AND (dta.end_time >= window_start OR dta.end_time IS NULL) and status = 1. Use this when the question implies "reported an alert during the period" (any occurrence in the window).
    - Example: "How many devices in USA reported high temperature alert in last 1 day" = get_area_bounds({ country: "United States" }), then COUNT DISTINCT devices from device_current_data cd JOIN user_device_assignment ud ON ud.device = cd.device_id JOIN area_bounds ab ON ab.id = <area_bound_id> AND ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(cd.longitude, cd.latitude), 4326)) JOIN device_temperature_alert dta ON dta.device_id = cd.device_id AND dta.type = 1 AND dta.start_time <= NOW() AND (dta.end_time >= NOW() - INTERVAL '1 day' OR dta.end_time IS NULL) WHERE ud.user_id = '<user_id>'. Alternatively with device_alerts: JOIN device_alerts da ON da.device_id = cd.device_id WHERE da.max_temperature_event_time >= NOW() - INTERVAL '1 day'.

    Important Field Notes:
    - Temperature values are stored in degrees Celsius (°C)
    - device_geofencings table does NOT have latitude/longitude fields - join with facilities table for coordinates
    - Dwell time is stored in seconds (1 day = 86400 seconds)
    - Facility types: M (manufacturer), R (retailer), U, D, etc.

    Geographic Query Patterns:
    - For device_current_data queries: Use cd.longitude and cd.latitude
    - For journey between facilities/geofencing queries: JOIN facilities table and use f.longitude and f.latitude
    - For geographic filtering: use the area_bound_id from get_area_bounds and JOIN area_bounds (e.g. alias ab). Use ST_Contains(ab.boundary, point) - do NOT embed POLYGON or MULTIPOLYGON text in the query
    - NEVER use placeholder text like "...coordinates..." - use the area_bound_id from the tool and JOIN area_bounds

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
    - The tool returns success, area_bound_id, and area_name. Use area_bound_id in your SQL: JOIN area_bounds ab ON ab.id = <area_bound_id> and filter with ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))
    - If the tool fails, inform the user that the area boundary could not be determined
    - NEVER generate POLYGON/MULTIPOLYGON coordinates yourself - always use get_area_bounds and then JOIN area_bounds by id

    Geographic fallback (only if get_area_bounds fails and you cannot use area_bounds):
    - Use a simple bounding box POLYGON only when the tool fails and no area_bound_id is available (e.g. Mexico: POLYGON((-118.4 14.5, -86.8 14.5, -86.8 32.7, -118.4 32.7, -118.4 14.5)))

    Journey between facilities Calculation Rules:
    - Journey between facilities = device movement from one facility_id to another facility_id
    - Journey between facilities calculations use specialized tools (journey_list_tool, journey_count_tool)
    - These tools execute SQL to fetch geofencing rows, then run algorithm to calculate journeys between facilities
    - Journey time must be >= 4 hours (14400 seconds) between different facilities
    - For same facility (A -> A), minimum time is 4 hours + extraJourneyTimeLimit (if provided)

    SQL Query Best Practices:
    - Always filter by user_id using user_device_assignment table unless user is admin. filter on user_id, join with other table(eg device_current_data as dc) by dc.device_id = user_device_assignment.device
    - SELECT only specific columns needed, never use SELECT *
    - For journey queries with geographic filters, include useful fields: device_id, device_name, facility_id, facility_name, facility_type, entry_event_time, exit_event_time, latitude, longitude
    - When joining device_geofencings with facilities for coordinates: LEFT JOIN facilities f ON f.facility_id = dg.facility_id
    - For geographic filtering on journeys: JOIN area_bounds ab ON ab.id = <area_bound_id from get_area_bounds> and use WHERE ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(f.longitude, f.latitude), 4326))

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
      - IMPORTANT: If user mentions a location, FIRST call get_area_bounds with STRUCTURED parameters (e.g. country, state, city). Use the returned area_bound_id in your SQL.
      - For geographic filter: JOIN area_bounds ab ON ab.id = <area_bound_id> and add:
        WHERE ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(f.longitude, f.latitude), 4326))
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
  - Other tables (device_current_data, device_geofencings,incoming_message_history_k,sensor,shock_info,device_temperature_alert etc.) have "device_id" field
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
      const exampleDocs = await vectorStore.searchExamples(question, 5);
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
      getTablesImportantFieldsTool,
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
  chatId?: string,
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
  history?: any;
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
    );
    
    // Construct final system prompt: Static (cached) + Dynamic (RAG) + User question
    // The static prefix will be cached, dynamic sections change per request
    // On subsequent messages, staticPrefix will be empty

    // const finalSystemPrompt = isFirstMessage 
    //   ? staticPrefix + dynamicSections 
    //   : dynamicSections;

    const finalSystemPrompt = staticPrefix + dynamicSections;

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
      chatId,
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
    


    const ai_chat = await AiChat.findByPk(chatId);
    if (!ai_chat) {
      throw new Error(`Chat entry not found for chatId: ${chatId}`);
    }
    const previousResponseId = ai_chat?.previous_response_id || null;
    const lastMessage = await AiChatMessage.findOne({ where: { chat_id: chatId }, order: [['created_at', 'DESC']], raw: true });
    console.log('-----> lastMessage:', lastMessage);

    const previousHistory = (lastMessage?.history || []).slice(-30);
    let thread: AgentInputItem[] = previousHistory as AgentInputItem[];

    // console.log('-----> previousResponseId:', previousResponseId);

    // const other_option: any = previousResponseId ? { previousResponseId } : {};
    const other_option : any = {  };

    // Run the agent
    // Note: Conversation history is managed by OpenAI's API automatically when using the same conversationId
    // The model will maintain context across requests when using the same agent instance
    // For now, we rely on the model's built-in conversation management
    // The static prefix in the system prompt will be cached by OpenAI automatically
    // when it's >= 1024 tokens and matches previous requests
    const result: any = await run(updatedAgent,  thread.concat({ role: 'user', content: question }), other_option);

    // if(result.lastResponseId) {
    //   await AiChat.update({ previous_response_id: result.lastResponseId }, { where: { id: chatId } });
    // }

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
      history: result.history,
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
