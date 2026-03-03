import { Agent, AgentInputItem, run } from '@openai/agents';
import { OpenAIChatCompletionsModel, setDefaultOpenAIKey } from '@openai/agents-openai';
import OpenAI from 'openai';
import { settings } from '../config/settings';
import { VectorStoreService } from '../services/vectorStore';
import {
  // checkUserQueryRestrictionTool,
  executeDbQueryTool,
  countQueryTool,
  listQueryTool,
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
import { sequelizeReadOnly } from '../config/database';
import { getAiModelName } from '../config/aiSettings';
import { QueryTypes } from 'sequelize';

interface UserRoleInfo {
  roleId: number;
  companyId: number | null;
  adminUserId: number | null;
}

async function getUserRoleInfo(userId: string): Promise<UserRoleInfo | null> {
  try {
    const rows = await sequelizeReadOnly.query(
      `SELECT role_id, company_id, id FROM admin WHERE id = :userId LIMIT 1`,
      { type: QueryTypes.SELECT, replacements: { userId } },
    ) as any[];

    if (rows.length === 0) return null;

    return {
      roleId: rows[0].role_id,
      companyId: rows[0].company_id ?? null,
      adminUserId: rows[0].user_id ?? null,
    };
  } catch (error) {
    logger.warn(`Failed to fetch role info for userId ${userId}: ${error}`);
    return null;
  }
}

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
  const toolsList = ' count_query, list_query, execute_db_query, get_table_structure, get_area_bounds, facility_journey_list_tool, facility_journey_count_tool, custom_script_tool';

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
    6. Full column schema from DB (when needed) → get_table_structure

    CRITICAL RULES:
    1. ALWAYS execute queries using tools. NEVER just describe a query.
    2. After executing a tool, provide a natural language answer based on results.
    3. DO NOT include SQL in your final answer.
    4. NEVER add LIMIT clause — tools handle pagination and CSV generation automatically.
    5. Never explain SQL/schema, table names, or column names in answers.
    6. On errors, say: "I'm unable to retrieve that information at the moment."
    7. When querying shock_info for shock or free-fall alerts/counts/lists: ALWAYS add a type condition. Shock-only → AND type = 'shock'. Free-fall only → AND type = 'free_fall'. Both → AND type IN ('shock','free_fall').

    CLARIFICATION & CONFIRMATION:
    - If the user's question is ambiguous or could be interpreted in multiple ways, ASK the user for clarification before executing.
    - You may respond with a short question, yes/no options, or a numbered list of choices for the user to pick from.
    - Examples: "Did you mean X or Y?", "I can interpret this as: 1) ... 2) ... Which one?", "Do you want current data or historical?"
    - This is especially important for journey questions — if unclear whether the user means regular journey or facility journey, ASK before proceeding.

    TONE & RESPONSE STYLE (Human-Friendly):
    - Never use technical jargon in your reasoning or answers. Do NOT use: "query", "database", "table", "SQL", "server", "data slice".
    - Use business-friendly language instead: "process", "report", "lookup", "search", "details", "information", or "request".
    - When a request is too large to handle, explain it as a process limit. Say something like: "I am unable to process the full list at once because there is a high volume of information. Please help me narrow down the search by providing a specific time range or location." Do NOT say things like "The query timed out due to data size."

    ================================================================
    DATABASE TABLES & SCHEMA REFERENCE
    ================================================================

    PK=Primary Key, UK=Unique Key, FK=Foreign Key

    1. device_details_table (D) — Device information metadata, identifiers
       PK: sno | UK: device_id
       Fields: device_id, device_name, imei, grai_id, iccid, imsi
       ### Indexes
       - (sno) UNIQUE
       - (device_id) UNIQUE

    2. user_device_assignment (UD) — User→device access mapping. ALWAYS join for user filtering.
       PK: id
       Fields: user_id (FK→admin.id), device_id (FK→*.device_id)
       ### Indexes
       - (device_id, user_id)
       - (user_id, device_id)

    3. device_current_data (CD) — Current/latest device snapshot (location, sensors, alerts)
       PK: id | UK: device_id
       Fields: device_id, device_name, grai_id, imei,
       latitude, longitude, h3_id, location_type,
       facility_id (FK→facilities), facility_type (M/R/U/D),
       event_time (last location), updated_at (last reported),
       temperature (°C), battery (%),
       travel_distance (meters), dwell_time_seconds (sec), dwell_time (human: "1D"/"2H"/"10M"),
       shock_id (FK→shock_info.id), shock_event_time (use for "devices w/ shock after [date]" — avoid joining shock_info),
       free_fall_id (FK→shock_info.id), free_fall_event_time (same for free-fall)
       ### Indexes
       - (facility_id)
       - (device_id) UNIQUE
       - (id) UNIQUE
       - (device_id, free_fall_event_time)
       - (device_name)
       - (dwell_time_seconds)
       - (event_time)
       - (free_fall_event_time)
       - (shock_event_time)
       - (longitude, latitude) -> GIS (GiST)
       - (device_id, longitude, latitude) -> GIS Composite (GiST)
       - (device_id, shock_event_time)
       - (device_id, facility_type)
       - (device_id, facility_id)
       - (device_id, event_time)
       - (device_id, dwell_time_seconds)

    4. incoming_message_history_k (IK) — Historical device location/sensor log
       PK: sno
       Fields: device_id, event_time, timestamp (reported time),
       latitude, longitude, temperature (°C), battery (%),
       facility_id (FK→facilities), facility_type,
       dwell_time (human), dwell_timestamp (sec),
       travel_distance (meters), accuracy (meters), altitude (meters), address (JSON)
       ### Indexes
       - (longitude, latitude) -> GIS (GiST)
       - (device_id, event_time, longitude, latitude) -> GIS Composite (GiST)
       - (device_id, event_time) DESC
       - (sno, event_time) DESC

    5. device_geofencings (DG) — Facility entry/exit records. ⚠️ NO latitude/longitude columns.
       PK: id
       Fields: device_id, facility_id (FK→facilities), facility_type,
       entry_event_time, exit_event_time, facility_last_event_time
       ### Indexes
       - (facility_type, entry_event_time, exit_event_time, device_id)
       - (device_id, facility_type, entry_event_time, exit_event_time, facility_last_event_time)
       - (device_id, facility_type, facility_last_event_time, entry_event_time)

    6. facilities (F) — Facility/warehouse info with coordinates
       PK: id | UK: facility_id
       Fields: facility_id, facility_name, facility_type (M/R/U/D),
       latitude, longitude, street, city, state, zip_code,
       company_id (FK→admin.company_id for role_id=2), is_active (0=inactive, 1=active)
       ### Indexes
       - (facility_type)
       - (company_id)
       - (latitude, longitude)
       - (longitude, latitude) -> GIS (GiST)
       - (facility_id, longitude, latitude) -> GIS Composite (GiST)
       - (company_id, longitude, latitude) -> GIS Composite (GiST)
       - (facility_id) UNIQUE
       - (facility_id, company_id)
       - (facility_name)
       - (is_active)

    7. sensor (S) — Temperature/battery sensor readings history
       PK: id | UK: imt_id (FK→incoming_message_history_k.sno)
       Fields: device_id, temperature (°C), battery (%), event_time
       ### Indexes
       - (device_id, event_time)
       - (event_time) DESC
       - (id) UNIQUE

    8. shock_info — Full shock/free-fall event history (large table — avoid for simple "list devices w/ shock")
       PK: id
       Fields: device_id, type ('shock'|'free_fall'), time_stamp (event time),
       latitude, longitude, location_event_time,
       imt_k_id (FK→incoming_message_history_k.sno)
       MANDATORY: When using this table, ALWAYS filter by type. "Shock alert/count/list" → AND si.type = 'shock'. "Free-fall" → AND si.type = 'free_fall'. Both → No need to filter by type.
       ### Indexes
       - (device_id, type, time_stamp) DESC
       - (longitude, latitude) -> GIS (GiST)
       - (device_id, longitude, latitude) -> GIS Composite (GiST)

    9. device_temperature_alert — Temperature alert history with location
       PK: id
       Fields: device_id, start_time, end_time,
       type (0=min temp, 1=max temp), threshold_value (°C trigger), threshold_duration (sec min duration to trigger),
       status (0=inactive, 1=active — becomes 1 when temp outside threshold > threshold_duration),
       latitude, longitude, location_event_time,
       imt_k_id (FK→incoming_message_history_k.sno)
       ### Indexes
       - (device_id, end_time)
       - (device_id, status)
       - (device_id)
       - (device_id, start_time, end_time) DESC
       - (id) UNIQUE
       - (start_time, end_time) DESC
       - (longitude, latitude) -> GIS (GiST)

    10. device_alerts — Last alert per device (simplified view)
        PK: id | UK: device_id
        Fields: device_id,
        min_temperature, min_temperature_event_time, min_temperature_sensor_id (FK→sensor.id),
        max_temperature, max_temperature_event_time, max_temperature_sensor_id (FK→sensor.id),
        battery, battery_event_time, battery_sensor_id (FK→sensor.id),
        light, light_event_time, light_id (FK→light_data.id)
        ### Indexes
        - (device_id, battery_event_time)
        - (device_id, max_temperature_event_time)
        - (device_id, min_temperature_event_time)
        - (battery_event_time)
        - (max_temperature_event_time)
        - (min_temperature_event_time)

    11. device_settings_data — Current device thresholds
        PK: id | UK: device_id
        Fields: device_id,
        ltth (low temp threshold °C), htth (high temp threshold °C),
        ltdth (low temp duration sec), htdth (high temp duration sec),
        lbth (low battery %), hdth (high dwell-time sec)
        ### Indexes
        - (device_id) UNIQUE

    12. device_settings_history — Threshold change history
        PK: id
        Fields: device_id, name (ltth/htth/ltdth/htdth/lbth/hdth),
        value, value_type (real/integer), start_time, end_time
        ### Indexes
        - (device_id)
        - (device_id, name)
        - (device_id, end_time)
        - (device_id, start_time)
        - (id) UNIQUE

    13. area_bounds (AB) — Geographic boundaries (populated by get_area_bounds tool)
        PK: id
        Fields: area_name, boundary (geometry — use with ST_Contains), location_params (jsonb)

    14. admin — User accounts
        PK: id | UK: user_id
        Fields: user_id, role_id (1=super-admin, 2=user, 3=sub-user), company_id

    15. facility_sub_users — Facility↔sub-user mapping (for role_id=3 sub-users)
        PK: id
        Fields: user_id (FK→admin.user_id), facility_id (FK→facilities.facility_id)
        ### Indexes
        - (company_id)
        - (facility_id)
        - (user_id)
        - (facility_id, user_id) UNIQUE

    16. light_data — Light sensor readings
        PK: id
        Fields: device_id, event_time, light (lux),
        imt_id (FK→incoming_message_history_k.sno)
        ### Indexes
        - (device_id, event_time) DESC

    ================================================================
    FACILITY ACCESS BY ROLE
    ================================================================

    The user's role_id (provided in the dynamic FACILITY ACCESS section below) determines which facilities are visible.
    Apply this filter whenever the facilities table appears in ANY query (direct queries, JOINs, subqueries, facility journeys).

    - role_id=1 (super-admin): No facility filtering.
    - role_id=2 (company user): Filter by f.company_id = <company_id> (value provided in FACILITY ACCESS section).
    - role_id=3 (sub-user): JOIN facility_sub_users fsu ON fsu.facility_id = f.facility_id AND fsu.user_id = <admin_user_id> (value provided in FACILITY ACCESS section).

    ⚠️ This filter is IN ADDITION TO user_device_assignment filtering on devices.

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

    SPATIAL SEARCH RULES (polygon/area filtering — follow exactly for correct SQL):
    - Polygon filtering: When filtering by an area (e.g. area_bounds), always use ST_Contains(boundary_column, point_geometry). Example: ST_Contains(ab.boundary, <point_expression>).
    - Point generation: Always wrap the point in SRID for index compatibility: ST_SetSRID(ST_MakePoint(longitude, latitude), 4326). This avoids SRID mismatch and works with GIST indexes.
    - Coordinate order: Inside ST_MakePoint use LONGITUDE first, then LATITUDE: ST_MakePoint(longitude, latitude). Example: ST_MakePoint(cd.longitude, cd.latitude).

    GEOGRAPHIC FILTERING EXAMPLES (all use the pattern above):
    - "Devices currently in California" → ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(cd.longitude, cd.latitude), 4326))
    - "Devices that traveled through USA last week" → ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(ik.longitude, ik.latitude), 4326)) AND ik.event_time >= NOW() - INTERVAL '7 days'
    - "Facility journeys in New York" → ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(f.longitude, f.latitude), 4326))
    - "Temperature alerts in California" → ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(dta.longitude, dta.latitude), 4326))
    - "Shock events in Texas" → ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(si.longitude, si.latitude), 4326))

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
         JOIN user_device_assignment ud ON ud.device_id = ik.device_id
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
         JOIN user_device_assignment uda ON uda.device_id = dg.device_id
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

    The tool returns a boundary only when the API returns Polygon/MultiPolygon (regions). Passing wrong parameters (e.g. country "/" or state without country) can return a Point (address) and the tool will FAIL. Always pass parameters that request a region:

    - Countries: { country: "United States" } or { country: "Mexico" }. Use full country name. Do NOT use "/" or empty.
    - US States (California, Texas, New York, etc.): ALWAYS pass BOTH: { country: "United States", state: "California" }. Never pass only state or country: "/" — that can return a Point and fail.
    - Cities: { country: "United States", city: "Los Angeles" } or { state: "New York", city: "New York" } when ambiguous.
    - Combine for states: { country: "United States", state: "California" }. Fallback only when no region fits: { q: "location name" }.

    Examples that work: "in California" → { country: "United States", state: "California" }; "in USA" → { country: "United States" }. Wrong: { country: "/", state: "California" } or { state: "California" } without country.

    Returns: { success, area_bound_id, area_name }. In SQL use spatial rules: JOIN area_bounds ab ON ab.id = <area_bound_id> AND ST_Contains(ab.boundary, ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)) — longitude first, latitude second. Never paste POLYGON/MULTIPOLYGON text into queries.

    ================================================================
    SQL BEST PRACTICES
    ================================================================

    - Always filter by user_id via user_device_assignment unless admin
    - JOIN: user_device_assignment ud ON ud.device_id = other_table.device_id
    - SELECT only needed columns, never SELECT *
    - Temperature in Celsius (°C), dwell time in seconds (86400 = 1 day)
    - Facility types: M (manufacturer), R (retailer), U, D, etc.
    - Use the schema reference above to construct queries — adapt JOINs, filters, and aggregations to match the user's intent
    - Only refuse if query accesses other users' data

    ================================================================
    SQL QUALITY GATE — INTERNAL REVIEW BEFORE EXECUTION
    ================================================================

    Before executing ANY SQL, internally reason through three expert perspectives in one pass:

    1. LOGIC ARCHITECT — Does the SQL actually answer the user's intent?
       - Correct table for current vs historical data?
       - Right JOINs, WHERE filters, and aggregations for the specific question?
       - Counting distinct entities when asked "how many"?

    2. SCHEMA DBA — Does every identifier match the schema above exactly?
       - All table names, column names, and data types verified against schema?
       - FK relationships joined correctly (e.g., ud.device_id = cd.device_id)?
       - No invented columns or wrong aliases?

    3. PERFORMANCE ENGINEER — Will this query run safely?
       - No SELECT *, no Cartesian products, no missing user_id filter?
       - Large tables (shock_info, incoming_message_history_k) filtered by time range or device_id?
       - Avoid joining shock_info for simple "list devices with shock" — use device_current_data.shock_event_time instead?

    DECISION: If any check fails → fix the query before executing. Never execute a query that fails any check.
    If all checks pass → execute immediately with the appropriate tool.

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
 * Build dynamic prompt sections (user-specific context)
 */
function buildDynamicPromptSections(userId: string, roleInfo: UserRoleInfo | null): string {
  const isAdmin = userId && userId.toLowerCase() === 'admin';

  if (isAdmin) {
    return `

ADMIN MODE: The user_id for this request is: ${userId}. No user_id filtering required; query across all users. No facility filtering required. Do NOT ask the user for their user ID.
`;
  }

  let prompt = `

USER MODE: The user_id for this request is: ${userId}. Do NOT ask the user for their user ID.
- ALWAYS filter by ud.user_id = '${userId}'
- ALWAYS join user_device_assignment (ud) ON ud.device_id = other_table.device_id
- Aggregations, GROUP BY, COUNT, SUM, etc. are ALLOWED for this user_id's data
- Time ranges (days, months, years) are ALLOWED — adapt INTERVAL values as needed
- Multiple visits, repeated facilities, patterns are ALLOWED for this user_id
- ONLY refuse if query would access OTHER users' data (user_id != ${userId})
- Never explain SQL/schema in answers
`;

  if (roleInfo) {
    prompt += `
FACILITY ACCESS (role_id=${roleInfo.roleId}):
`;
    if (roleInfo.roleId === 1) {
      prompt += `- Super-admin: full access to all facilities. No facility filtering needed.\n`;
    } else if (roleInfo.roleId === 2 && roleInfo.companyId != null) {
      prompt += `- Company user: MUST filter facilities by company_id = ${roleInfo.companyId}
      - Whenever the facilities table (f) appears in a query, add: f.company_id = ${roleInfo.companyId}
      - For device_geofencings joins: LEFT JOIN facilities f ON f.facility_id = dg.facility_id AND f.company_id = ${roleInfo.companyId}
      - For direct facility queries: WHERE f.company_id = ${roleInfo.companyId}
      `;
    } else if (roleInfo.roleId === 3 && roleInfo.adminUserId != null) {
      prompt += `- Sub-user: MUST filter facilities via facility_sub_users table with user_id = ${roleInfo.adminUserId}
      - Whenever the facilities table (f) appears in a query, add:
        JOIN facility_sub_users fsu ON fsu.facility_id = f.facility_id AND fsu.user_id = ${roleInfo.adminUserId}
      - For direct facility queries: JOIN facility_sub_users fsu ON fsu.facility_id = f.facility_id WHERE fsu.user_id = ${roleInfo.adminUserId}
      `;
    }
  }

  return prompt;
}

/**
 * Build complete system prompt with static + dynamic sections
 */
function buildSystemPrompt(
  userId: string,
  isJourney: boolean = false,
  roleInfo: UserRoleInfo | null = null,
): { staticPrefix: string; dynamicSections: string } {
  const staticPrefix = buildStaticPromptPrefix(isJourney);
  const dynamicSections = buildDynamicPromptSections(userId, roleInfo);

  return { staticPrefix, dynamicSections };
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

  setDefaultOpenAIKey(settings.openaiApiKey);

  const client = new OpenAI({ apiKey: settings.openaiApiKey });
  const modelName = await getAiModelName();
  const model = new OpenAIChatCompletionsModel(client as any, modelName);

  // Create agent with tools (instructions will be set per request for caching)
  const agent = new Agent({
    name: 'SQL Assistant',
    instructions: '', // Will be set per request
    model,
    tools: [
      // checkUserQueryRestrictionTool,
      executeDbQueryTool,
      countQueryTool,
      listQueryTool,
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
    const isJourney = detectJourneyQuestion(question);
    const roleInfo = userId.toLowerCase() !== 'admin' ? await getUserRoleInfo(userId) : null;

    const { staticPrefix, dynamicSections } = buildSystemPrompt(userId, isJourney, roleInfo);

    const finalSystemPrompt = staticPrefix + dynamicSections;

    const modelName = await getAiModelName();
    const client = new OpenAI({ apiKey: settings.openaiApiKey });
    const model = new OpenAIChatCompletionsModel(client as any, modelName);

    const promptCacheKey = isJourney ? 'sql_assistant_journey_v1' : 'sql_assistant_v1';

    const updatedAgent = new Agent({
      name: agent.name || 'SQL Assistant',
      instructions: finalSystemPrompt,
      model,
      tools: agent.tools || [],
    });

    logger.info('💬 CONVERSATION START', {
      userId,
      chatId,
      question,
      isJourney,
      promptCacheKey,
      model: modelName,
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
