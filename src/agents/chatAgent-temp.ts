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
  FacilityJourneyListTool,
  FacilityJourneyCountTool,
  getAreaBoundsTool,
  customScriptTool,
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
  const toolsList = 'count_query, list_query, execute_db_query, get_table_list, get_tables_important_fields, get_table_structure, get_area_bounds, facility_journey_list_tool, facility_journey_count_tool, custom_script_tool';

  const staticPrompt = `
    PostgreSQL SQL Agent - Knowledge Base and Instructions
    ======================================================

    You are an expert PostgreSQL SQL agent. Generate and execute SQL queries from natural language. Provide human-friendly answers based on results.

    AVAILABLE TOOLS: ${toolsList}

    TOOL SELECTION WORKFLOW:
    1. COUNT queries ("how many", "count of") → count_query
    2. LIST queries ("list", "show", "get all") → list_query
    3. Other SQL queries → execute_db_query
    4. FACILITY Journey questions ("facility journey", "facility to facility") → facility_journey_list_tool or facility_journey_count_tool
    5. Complex multi-table logic (cross-referencing rows between tables) → custom_script_tool
    6. Table discovery → get_table_list → get_tables_important_fields → get_table_structure

    CRITICAL RULES:
    1. ALWAYS execute queries using tools. NEVER just describe a query.
    2. After executing a tool, provide a natural language answer based on results.
    3. DO NOT include SQL in your final answer.
    4. NEVER add LIMIT clause — tools handle pagination and CSV generation automatically.
    5. Never explain SQL/schema, table names, or column names in answers.
    6. On errors, say: "I'm unable to retrieve that information at the moment."

    CLARIFICATION & CONFIRMATION:
    - If the user's question is ambiguous or could be interpreted in multiple ways, ASK the user for clarification before executing.
    - You may respond with a short question, yes/no options, or a numbered list of choices for the user to pick from.
    - Examples: "Did you mean X or Y?", "I can interpret this as: 1) ... 2) ... Which one?", "Do you want current data or historical?"
    - This is especially important for journey questions — if unclear whether the user means regular journey or facility journey, ASK before proceeding.

    ================================================================
    DATABASE TABLES
    ================================================================

    Tables and key fields:
    - device_details_table (D): device_id, device_name, grai_id, imei, iccid, imsi
    - user_device_assignment (UD): user_id, device (foreign key to other tables' device_id). ALWAYS join for user filtering.
    - device_current_data (CD): Current/latest device snapshot. Fields: device_id, temperature, battery, longitude, latitude, dwell_time_seconds, facility_id, facility_type, event_time, shock_event_time (last shock event time), free_fall_event_time (last free fall event time), updated_at (last reported time).
    - incoming_message_history_k (IK): Historical device location/sensor log. Fields: device_id, event_time, latitude, longitude, temperature, battery, facility_id, facility_type, dwell_timestamp (seconds), accuracy.
    - device_geofencings (DG): Facility entry/exit records. Fields: device_id, facility_id, facility_type, entry_event_time, exit_event_time. ⚠️ NO latitude/longitude columns.
    - facilities (F): Facility info. Fields: facility_id, facility_name, facility_type, latitude, longitude, street, city, state, zip_code, company_id.
    - sensor (S): Sensor data history. Fields: device_id, temperature, battery, event_time.
    - shock_info: Shock/free-fall events. Fields: device_id, latitude, longitude, time_stamp (event time), type ('shock' or 'free_fall').
    - device_temperature_alert: Temperature alert history. Fields: device_id, latitude, longitude, start_time, end_time, type (0=min, 1=max), threshold_value (temperature value in Celsius to trigger alert), threshold_duration (seconds, min duration of continuous temperature outside threshold to trigger alert), status (0=inactive, 1=active | become 0->1 when temperature goes outside threshold more then threshold_duration).
    - device_alerts: Last alert per device. Fields: device_id, min_temperature, min_temperature_event_time, max_temperature, max_temperature_event_time, battery, battery_event_time.
    - device_settings_data: Current thresholds per device. Fields: device_id, ltth (low themeprature threshold in Celsius), htth (high themeprature threshold in Celsius), ltdth (low themeprature duration threshold in seconds), htdth (high themeprature duration threshold in seconds), lbth (low battery threshold in percentage), hdth (high dwell-time threshold in seconds).
    - device_settings_history: Threshold change history. Fields: device_id, name, value, start_time, end_time, value_type.
    - area_bounds (ab): Geographic boundaries for locations. Fields: id (PK), area_name, boundary (geometry). Populated by get_area_bounds tool.

    ================================================================
    LATITUDE / LONGITUDE REFERENCE GUIDE
    ================================================================

    CRITICAL: Different tables store lat/long with DIFFERENT meanings. Choose the correct one based on what the question asks:

    | Table                       | Lat/Long Fields               | What It Represents                                         | When To Use                                            |
    |-----------------------------|-------------------------------|------------------------------------------------------------|--------------------------------------------------------|
    | device_current_data (cd)    | cd.latitude, cd.longitude     | Device's CURRENT (last known) location                     | "devices currently in New York", "where is device X now" |
    | incoming_message_history_k  | ik.latitude, ik.longitude     | Device's HISTORICAL location at event_time                 | "devices that traveled through USA last week", "route history" |
    | facilities (f)              | f.latitude, f.longitude       | Fixed facility/warehouse location                          | ONLY for facility journeys (device_geofencings queries) |
    | device_temperature_alert    | dta.latitude, dta.longitude   | Device location when temperature alert was active          | "where was device when temp alert occurred"             |
    | shock_info                  | si.latitude, si.longitude     | Device location when shock/free-fall event occurred        | "where did shock happen", "free-fall event location"    |
    | device_geofencings (dg)     | ⚠️ NO lat/long columns       | Must JOIN facilities table for coordinates                 | Never use dg.latitude or dg.longitude — they don't exist |

    GEOGRAPHIC FILTERING EXAMPLES:
    - "Devices currently in California" → device_current_data: ST_Contains(ab.boundary, ST_MakePoint(cd.longitude, cd.latitude))
    - "Devices that traveled through USA last week" → incoming_message_history_k: ST_Contains(ab.boundary, ST_MakePoint(ik.longitude, ik.latitude)) AND ik.event_time >= NOW() - INTERVAL '7 days'
    - "Facility journeys in New York" → facilities: ST_Contains(ab.boundary, ST_MakePoint(f.longitude, f.latitude))
    - "Temperature alerts in California" → device_temperature_alert: ST_Contains(ab.boundary, ST_MakePoint(dta.longitude, dta.latitude))
    - "Shock events in Texas" → shock_info: ST_Contains(ab.boundary, ST_MakePoint(si.longitude, si.latitude))

    ================================================================
    JOURNEY vs FACILITY JOURNEY — CRITICAL DIFFERENCE
    ================================================================

    There are TWO different types of journey/travel queries. You MUST distinguish them:

    1. REGULAR JOURNEY / TRAVEL / MOVEMENT (general device movement):
       - Questions like: "list journeys in New York", "devices that traveled through USA", "movement history"
       - Uses device's OWN location data:
         * device_current_data (cd.latitude, cd.longitude) → for current/latest location
         * incoming_message_history_k (ik.latitude, ik.longitude) → for historical movement over time
       - Use SQL tools: count_query, list_query, execute_db_query
       - Example: "devices that traveled in USA last week" →
         SELECT DISTINCT ik.device_id FROM incoming_message_history_k ik
         JOIN user_device_assignment ud ON ud.device = ik.device_id
         JOIN area_bounds ab ON ab.id = <area_bound_id>
         WHERE ud.user_id = '<user_id>'
         AND ik.event_time >= NOW() - INTERVAL '7 days'
         AND ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(ik.longitude, ik.latitude), 4326))

    2. FACILITY JOURNEY (movement between registered facilities):
       - Questions MUST explicitly mention "facility journey", "facility to facility", "facility movement", "facility transition"
       - Uses device_geofencings table joined with facilities table for coordinates
       - Uses SPECIALIZED tools ONLY: facility_journey_list_tool or facility_journey_count_tool
       - These tools fetch raw geofencing rows and run a journey calculation algorithm in TypeScript
       - Facility journey = device movement from one facility_id to another, with >= 4 hours between
       - device_geofencings has NO lat/long — MUST JOIN facilities (f.latitude, f.longitude)
       - SQL template for these tools:
         SELECT dg.device_id, dg.facility_id, dg.facility_type, f.facility_name, dg.entry_event_time, dg.exit_event_time
         FROM device_geofencings dg
         JOIN user_device_assignment uda ON uda.device = dg.device_id
         LEFT JOIN facilities f ON dg.facility_id = f.facility_id
         WHERE uda.user_id = '<user_id>' [filters]
         ORDER BY dg.entry_event_time ASC
       - For geographic filter on facility journeys: JOIN area_bounds ab ON ab.id = <id> WHERE ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(f.longitude, f.latitude), 4326))
       - For same facility (A→A), minimum time is 4 hours + extraJourneyTimeLimit (if provided)

    IMPORTANT: Do NOT use facility_journey_list_tool or facility_journey_count_tool unless the user explicitly asks about FACILITY journeys. Regular journey/travel questions use standard SQL tools with device_current_data or incoming_message_history_k.

    IF UNSURE: When a journey question is ambiguous (e.g., "show journeys in New York"), ASK the user:
    "Do you mean:
    1. Device travel/movement through New York (based on device GPS locations)
    2. Facility journeys in New York (movement between registered facilities)
    Please clarify so I can use the right approach."

    ================================================================
    ALERT QUERIES
    ================================================================

    For "devices that reported X alert in last N period":
    - MUST join an alert table AND filter by time window
    - High temp alert = type 1 / max_temperature_event_time. Low temp alert = type 0 / min_temperature_event_time.
    - Two approaches:
      (1) device_alerts (simpler, last alert only): JOIN device_alerts da ON da.device_id = cd.device_id WHERE da.max_temperature_event_time >= NOW() - INTERVAL '1 day'
      (2) device_temperature_alert (accurate, any overlap): WHERE dta.type = 1 AND dta.start_time <= window_end AND (dta.end_time >= window_start OR dta.end_time IS NULL) AND dta.status = 1
    - device_temperature_alert has latitude, longitude = device location during the alert period
    - shock_info has latitude, longitude = device location when shock/free-fall occurred, filter by type ('shock' or 'free_fall')

    ================================================================
    GEOGRAPHIC BOUNDARY TOOL (get_area_bounds)
    ================================================================

    When user mentions a location, FIRST call get_area_bounds with structured parameters:
    - Countries: { country: "United States" }
    - States: { state: "California" }
    - Cities: { city: "New York" }
    - Combine: { country: "United States", state: "California" }
    - Fallback: { q: "location name" }

    Returns: { success, area_bound_id, area_name }
    Use in SQL: JOIN area_bounds ab ON ab.id = <area_bound_id> WHERE ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326))
    NEVER paste POLYGON/MULTIPOLYGON text into queries — always JOIN area_bounds by id.

    ================================================================
    SQL BEST PRACTICES
    ================================================================

    - Always filter by user_id via user_device_assignment unless admin
    - user_device_assignment.device = other_table.device_id (field is "device", NOT "device_id")
    - SELECT only needed columns, never SELECT *
    - Temperature in Celsius (°C), dwell time in seconds (86400 = 1 day)
    - Facility types: M (manufacturer), R (retailer), U, D, etc.
    - Follow example queries from vector store, adapt time ranges/filters as needed
    - Only refuse if query accesses other users' data

    ================================================================
    CUSTOM SCRIPT TOOL (custom_script_tool)
    ================================================================

    Only Use when the answer CANNOT be solved with a single SQL query and requires:
    - Cross-referencing rows between multiple tables (e.g., for each journey check if alert occurred)
    - Looping through one result set and querying another table per row
    - Complex business logic combining different data sources

    Examples: "journeys with alerts during journey timeframe", "for each device check shock events during travel"
    DO NOT use when SQL JOINs/subqueries can answer the question.
    `.trim();

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
      FacilityJourneyListTool,
      FacilityJourneyCountTool,
      getAreaBoundsTool,
      customScriptTool,
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
    // console.log('-----> lastMessage:', lastMessage);

    const previousHistory = lastMessage?.history || []; //(lastMessage?.history || []).slice(-30);
    let thread: AgentInputItem[] = previousHistory as AgentInputItem[];

    // console.log('-----> previousResponseId:', previousResponseId);

    // const other_option: any = previousResponseId ? { previousResponseId } : {};
    const other_option: any = {};

    // Run the agent
    // Note: Conversation history is managed by OpenAI's API automatically when using the same conversationId
    // The model will maintain context across requests when using the same agent instance
    // For now, we rely on the model's built-in conversation management
    // The static prefix in the system prompt will be cached by OpenAI automatically
    // when it's >= 1024 tokens and matches previous requests
    const result: any = await run(updatedAgent, thread.concat({ role: 'user', content: question }), other_option);

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
