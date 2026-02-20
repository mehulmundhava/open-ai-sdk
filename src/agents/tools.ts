import { tool } from '@openai/agents';
import { z } from 'zod';
import { DatabaseService } from '../services/database';
import { formatResultWithCSV, formatJourneyListWithCSV } from '../utils/csvGenerator';
import { TABLE_METADATA } from '../config/tableMetadata';
import { logger } from '../utils/logger';
import { sequelizeReadOnly } from '../config/database';
import { QueryTypes } from 'sequelize';
import {
  calculateJourneyCounts,
  calculateJourneyList,
  GeofencingRow,
} from '../services/journeyCalculator';
import simplify from 'simplify-js';

const databaseService = new DatabaseService();

/**
 * Check if a user's question/request is asking for restricted sensitive data
 */
function isRestrictedUserQuery(userQuestion: string): { isRestricted: boolean; reason?: string } {
  const questionLower = userQuestion.toLowerCase();

  // Patterns that indicate user is asking for direct data from sensitive tables
  const restrictedPatterns: Array<[RegExp, string?]> = [
    // Admin table patterns
    [/\badmin\s+(entry|data|row|record|list|table|information|details)/, 'admin'],
    [/\b(entry|data|row|record|list|table|information|details)\s+.*\badmin\b/, 'admin'],
    [/\b(\d+)(st|nd|rd|th)?\s+(admin|entry|row|record)/, 'admin'],
    [/\b(second|third|fourth|fifth)\s+(admin|entry|row|record)/, 'admin'],
    [/\bgive\s+me\s+admin/, 'admin'],
    [/\bshow\s+me\s+admin/, 'admin'],
    [/\bget\s+admin/, 'admin'],

    // User/assignment table patterns
    [/\buser_device_assignment\s+(entry|data|row|record|list|table)/, 'user_device_assignment'],
    [/\b(entry|data|row|record|list|table).*\buser_device_assignment\b/, 'user_device_assignment'],
    [/\buser\s+assignment\s+(entry|data|row|record|list)/, 'user_device_assignment'],

    // Generic patterns for asking for raw table data
    [/\bgive\s+me\s+.*\s+(entry|entries|row|rows|record|records|data|table)\s+data/, undefined],
    [/\bshow\s+me\s+.*\s+(entry|entries|row|rows|record|records|data|table)\s+data/, undefined],
    [/\bget\s+.*\s+(entry|entries|row|rows|record|records|data|table)\s+data/, undefined],
    [/\b(\d+)(st|nd|rd|th)?\s+(entry|row|record)\s+data/, undefined],
  ];

  for (const [pattern, table] of restrictedPatterns) {
    if (pattern.test(questionLower)) {
      return { isRestricted: true, reason: table || 'sensitive table' };
    }
  }

  return { isRestricted: false };
}

/**
 * Check user query restriction tool
 */
export const checkUserQueryRestrictionTool = tool({
  name: 'check_user_query_restriction',
  description: `Check if the user's question/request is asking for restricted sensitive data.
Call this tool FIRST with the user's original question before generating any SQL.

This tool validates if the user is asking for direct data from sensitive system tables
(like admin, user_device_assignment, etc.). If the question is restricted, it will return
an error message. If allowed, it will return "User query is allowed. You can proceed."`,
  parameters: z.object({
    user_question: z.string().describe('The user\'s natural language question/request'),
  }),
  execute: async ({ user_question }: { user_question: string }) => {
    logger.info(`🔧 TOOL CALLED: check_user_query_restriction`);
    logger.info(`   User Question: ${user_question}`);

    const { isRestricted, reason } = isRestrictedUserQuery(user_question);
    if (isRestricted) {
      const errorMsg = 'Sorry, I cannot provide that information.';
      logger.warn(`   ⚠️  BLOCKED: User is asking for restricted data (${reason})`);
      return errorMsg;
    }

    const allowedMsg = 'User query is allowed. You can proceed.';
    logger.info(`   ✅ ALLOWED: User query does not request restricted data`);
    return allowedMsg;
  },
});

/**
 * Execute database query tool
 */
export const executeDbQueryTool = tool({
  name: 'execute_db_query',
  description: `Execute a SQL query against the PostgreSQL database.

IMPORTANT: You MUST call check_user_query_restriction FIRST with the user's question before calling this tool.

Use this tool AFTER you have:
1. Called check_user_query_restriction with the user's question and received confirmation
2. Used the examples provided in the system prompt (from ai_vector_examples)
3. Generated a valid PostgreSQL query`,
  parameters: z.object({
    query: z.string().describe('A syntactically correct PostgreSQL query'),
  }),
  execute: async ({ query }: { query: string }) => {
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`🔧 TOOL CALLED: execute_db_query [${toolCallId}]`, {
      toolCallId,
      sqlQuery: query,
      queryLength: query.length,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await databaseService.executeQuery(query, true);

      if (!result || result.rowCount === 0) {
        logger.info('   Result: No rows returned');
        return ':::::: Query execution has returned 0 rows. Return final answer accordingly. ::::::';
      }

      const queryType = databaseService.detectQueryType(query);
      logger.info(`   Detected Query Type: ${queryType}`);

      // Handle result splitting for LIST queries
      if (queryType === 'list') {
        const rowCount = result.rowCount;
        logger.info(`   Result: ${rowCount} rows`);

        // If > 3 rows, format with CSV (returns count, preview, and CSV link)
        if (rowCount > 3) {
          logger.info(`   Large result detected (${rowCount} rows), generating CSV...`);
          const formattedResult = await formatResultWithCSV(result.formatted, 3);
          logger.info('   Formatted result with CSV link and count');
          return formattedResult;
        } else {
          // <= 3 rows, return original format with count prefix
          return `Total rows: ${rowCount}\n\n${result.formatted}`;
        }
      } else {
        // COUNT or other queries
        const rowCount = result.rowCount;
        logger.info(`   Result: ${rowCount} rows`);

        // If > 3 rows, format with CSV (same logic as LIST queries)
        if (rowCount > 3) {
          logger.info(`   Large result detected (${rowCount} rows), generating CSV...`);
          const formattedResult = await formatResultWithCSV(result.formatted, 3);
          logger.info('   Formatted result with CSV link and count');
          return formattedResult;
        } else {
          // <= 3 rows, return with count prefix
          return `Total rows: ${rowCount}\n\n${result.formatted}`;
        }
      }
    } catch (error: any) {
      const errorStr = String(error).toLowerCase();
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      
      logger.error(`❌ Query execution error:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      
      if (
        errorStr.includes('timeout') ||
        errorStr.includes('statement_timeout') ||
        errorStr.includes('canceling statement')
      ) {
        const errorMsg = `Query execution exceeded timeout and was killed.`;
        logger.error(`⏱️  Query timeout: ${errorMsg}`);
        return `:::::: Query execution timeout: The query took longer than expected and was automatically killed. Please optimize your query or use more specific filters. ::::::`;
      }

      // Return detailed error message for debugging
      const detailedError = `Error executing query: ${errorMessage}. ${errorStack ? `Stack: ${errorStack.substring(0, 200)}` : ''}`;
      logger.error(`   Full error details: ${detailedError}`);
      return `Error executing query: ${errorMessage}`;
    }
  },
});

/**
 * Count query tool - optimized for COUNT/aggregation queries
 */
export const countQueryTool = tool({
  name: 'count_query',
  description: `Execute COUNT or aggregation queries and return only the count/aggregation result.

Use this tool when the user asks for:
- Counts (e.g., "how many devices", "count of assets")
- Totals (e.g., "total temperature", "sum of battery")
- Aggregations (e.g., "average temperature", "maximum battery")

This tool is optimized for queries that return a single aggregated value.`,
  parameters: z.object({
    query: z.string().describe('SQL query that returns a count or aggregation (should use COUNT, SUM, AVG, MAX, MIN)'),
  }),
  execute: async ({ query }: { query: string }) => {
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`🔧 TOOL CALLED: count_query [${toolCallId}]`, {
      toolCallId,
      sqlQuery: query,
      queryLength: query.length,
      timestamp: new Date().toISOString(),
    });

    try {
      const result = await databaseService.executeCountQuery(query);
      logger.info(`   Count Result: ${result}`);
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ Count query execution error:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error: ${errorMessage}`;
    }
  },
});

/**
 * List query tool - optimized for LIST queries with automatic CSV generation
 */
export const listQueryTool = tool({
  name: 'list_query',
  description: `Execute LIST queries and return preview with CSV download link.

Use this tool when the user asks for:
- Lists of items (e.g., "list devices", "show assets", "get all facilities")
- Multiple rows of data

CRITICAL: The SQL query MUST NOT include a LIMIT clause. The tool will execute the full query and automatically:
1. Generate CSV file with ALL results
2. Return total row count
3. Show first 3 rows as preview
4. Provide CSV download link for full results

The query should return ALL matching rows - do not add LIMIT to the SQL query.`,
  parameters: z.object({
    query: z.string().describe('SQL query that returns a list of rows. MUST NOT include LIMIT clause - query will return all matching rows.'),
  }),
  execute: async ({ query }: { query: string }) => {
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`🔧 TOOL CALLED: list_query [${toolCallId}]`, {
      toolCallId,
      sqlQuery: query,
      queryLength: query.length,
      timestamp: new Date().toISOString(),
    });

    try {
      // Check if query contains LIMIT clause and warn
      const queryUpper = query.toUpperCase().trim();
      if (queryUpper.includes('LIMIT')) {
        logger.warn('⚠️  Query contains LIMIT clause - removing it to get full results');
        // Remove LIMIT clause from query
        const cleanedQuery = query.replace(/LIMIT\s+\d+/gi, '').trim().replace(/;\s*$/, '');
        logger.info(`   Cleaned query (removed LIMIT): ${cleanedQuery.substring(0, 100)}...`);
        query = cleanedQuery;
      }

      const result = await databaseService.executeListQuery(query, 3);

      if (!result || result.rowCount === 0) {
        logger.info('   Result: No rows returned');
        return 'No rows returned';
      }

      const rowCount = result.rowCount;
      logger.info(`   Result: ${rowCount} rows`);

      // Always format with CSV if > 3 rows (returns count, preview, and CSV link)
      if (rowCount > 3) {
        logger.info(`   Large result detected (${rowCount} rows), generating CSV...`);
        const formattedResult = await formatResultWithCSV(result.formatted, 3);
        logger.info('   Formatted result with CSV link and count');
        return formattedResult;
      } else {
        // <= 3 rows, return full result with count prefix
        return `Total rows: ${rowCount}\n\n${result.formatted}`;
      }
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ List query execution error:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error: ${errorMessage}`;
    }
  },
});

/**
 * Get table list tool
 */
export const getTableListTool = tool({
  name: 'get_table_list',
  description: `Get list of available tables with descriptions and important fields.

Use this tool ONLY if you cannot generate a query from the examples provided in the system prompt.
This is a LAST RESORT tool - try to use examples first.`,
  parameters: z.object({}),
  execute: async () => {
    logger.info(`🔧 TOOL CALLED: get_table_list`);

    try {
      // Return table metadata from config
      const tablesInfo = TABLE_METADATA.map((table) => ({
        name: table.name,
        description: table.description,
        important_fields: table.importantFields,
      }));

      const result = JSON.stringify(tablesInfo, null, 2);
      logger.info(`   Found ${tablesInfo.length} tables`);
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ Error getting table list:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error: ${errorMessage}`;
    }
  },
});

/**
 * Get table structure tool
 */
export const getTableStructureTool = tool({
  name: 'get_table_structure',
  description: `Get full column structure for specified tables.

Use this tool ONLY after get_table_list if you need detailed column information.
This is a LAST RESORT tool - try to use examples first.`,
  parameters: z.object({
    table_names: z.array(z.string()).describe('List of table names to get structure for'),
  }),
  execute: async ({ table_names }: { table_names: string[] }) => {
    logger.info(`🔧 TOOL CALLED: get_table_structure`);
    logger.info(`   Table Names: ${table_names.join(', ')}`);

    try {
      const structures: Record<string, any> = {};

      for (const tableName of table_names) {
        // Query PostgreSQL information_schema for table structure
        const query = `
          SELECT 
            column_name,
            data_type,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_name = :tableName
          ORDER BY ordinal_position
        `;

        const results = await sequelizeReadOnly.query(query, {
          type: QueryTypes.SELECT,
          replacements: { tableName },
        }) as any[];

        structures[tableName] = results.map((row) => ({
          column_name: row.column_name,
          data_type: row.data_type,
          is_nullable: row.is_nullable,
          column_default: row.column_default,
        }));
      }

      const result = JSON.stringify(structures, null, 2);
      logger.info(`   Retrieved structure for ${table_names.length} tables`);
      return result;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ Error getting table structure:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error: ${errorMessage}`;
    }
  },
});

/**
 * Parse SQL result into list of geofencing row dictionaries
 */
function parseSqlResultToGeofencingRows(result: any): GeofencingRow[] {
  const rows: GeofencingRow[] = [];

  if (!result) {
    return rows;
  }

  // If result is already an array of objects (from Sequelize SELECT)
  if (Array.isArray(result) && result.length > 0) {
    for (const row of result) {
      if (typeof row === 'object' && row !== null) {
        rows.push({
          device_id: String(row.device_id || ''),
          facility_id: String(row.facility_id || ''),
          facility_type: row.facility_type ? String(row.facility_type) : undefined,
          facility_name: row.facility_name ? String(row.facility_name) : undefined,
          entry_event_time: row.entry_event_time,
          exit_event_time: row.exit_event_time,
        });
      }
    }
    return rows;
  }

  // If result is a formatted string (pipe-separated)
  if (typeof result === 'string') {
    const lines = result.trim().split('\n');
    if (lines.length < 2) {
      return rows;
    }

    // First line is headers
    const headers = lines[0].split('|').map((h) => h.trim()).filter((h) => h);

    // Remaining lines are data
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const values = line.split('|').map((v) => v.trim());
      if (values.length !== headers.length) {
        continue;
      }

      const row: any = {};
      for (let j = 0; j < headers.length; j++) {
        row[headers[j]] = values[j] || null;
      }

      rows.push({
        device_id: String(row.device_id || ''),
        facility_id: String(row.facility_id || ''),
        facility_type: row.facility_type ? String(row.facility_type) : undefined,
        facility_name: row.facility_name ? String(row.facility_name) : undefined,
        entry_event_time: row.entry_event_time,
        exit_event_time: row.exit_event_time,
      });
    }
  }

  return rows;
}

/**
 * Journey list tool - calculates journey list from geofencing data
 */
export const journeyListTool = tool({
  name: 'journey_list_tool',
  description: `Calculate journey list from geofencing data. For journey/movement questions only.

SQL MUST use: device_geofencings dg, JOIN user_device_assignment uda ON uda.device = dg.device_id
Select: dg.device_id, dg.facility_id, dg.facility_type, dg.entry_event_time, dg.exit_event_time
Order: ORDER BY dg.entry_event_time ASC

This tool:
1. Executes SQL to fetch raw geofencing rows
2. Runs journey calculation algorithm in TypeScript
3. Returns structured journey list (NOT raw SQL rows)
4. Generates CSV for large results (>3 journeys)`,
  parameters: z.object({
    sql: z.string().describe('SELECT query to fetch geofencing rows. MUST NOT include LIMIT clause.'),
    params: z
      .object({
        from_facility: z.string().nullable().optional().describe('Filter journeys starting from this facility ID'),
        extraJourneyTimeLimit: z.number().nullable().optional().describe('Extra hours for same-facility journey validation'),
      })
      .nullable()
      .optional()
      .describe('Optional parameters for journey calculation'),
  }),
  execute: async ({ sql, params }: { sql: string; params?: { from_facility?: string | null; extraJourneyTimeLimit?: number | null } | null }) => {
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`🔧 TOOL CALLED: journey_list_tool [${toolCallId}]`, {
      toolCallId,
      sqlQuery: sql,
      params,
      timestamp: new Date().toISOString(),
    });

    try {
      // Validate SQL is SELECT only
      const sqlUpper = sql.trim().toUpperCase();
      if (!sqlUpper.startsWith('SELECT')) {
        const errorMsg = 'Only SELECT queries are allowed for journey calculations';
        logger.error(`   ❌ ${errorMsg}`);
        return errorMsg;
      }

      // Execute query
      const result = await databaseService.executeQuery(sql, true);

      if (!result || result.rowCount === 0) {
        logger.info('   Result: No geofencing rows returned');
        return JSON.stringify({
          facilities_details: {},
          journies: [],
        });
      }

      // Parse query results into list of dicts
      const geofencingRows = parseSqlResultToGeofencingRows(result.rows);

      logger.info(`   Parsed ${geofencingRows.length} geofencing rows from SQL result`);

      if (geofencingRows.length === 0) {
        logger.warn('   ⚠️ WARNING: SQL returned data but parsing failed!');
        return JSON.stringify({
          error: 'Failed to parse SQL results',
          facilities_details: {},
          journies: [],
        });
      }

      // Extract parameters
      const extraJourneyTimeLimit = params?.extraJourneyTimeLimit || null;
      const fromFacility = params?.from_facility || null;

      // Run journey calculation
      const filterNote = fromFacility ? ` (filtering from_facility=${fromFacility})` : '';
      logger.info(`   Processing ${geofencingRows.length} geofencing rows with journey algorithm${filterNote}...`);
      const journeyResult = calculateJourneyList(geofencingRows, extraJourneyTimeLimit, fromFacility);

      const journeyCount = journeyResult.journies.length;
      const facilitiesCount = Object.keys(journeyResult.facilities_details).length;

      // Format result with CSV if > 3 journeys
      // if (journeyCount > 3) {
        logger.info(`   📊 Large result detected (${journeyCount} journeys), generating CSV...`);
        const resultJson = await formatJourneyListWithCSV(journeyResult, 3);
        logger.info(`   ✅ Showing first 3 journeys, CSV available for all ${journeyCount} journeys`);
        return resultJson;
      // } else {
      //   // Format result normally (no CSV needed)
      //   const resultJson = JSON.stringify(journeyResult, null, 2);
      //   logger.info(`   ✅ Showing all ${journeyCount} journeys (no CSV needed)`);
      //   return resultJson;
      // }
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ Journey list calculation error:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error calculating journeys: ${errorMessage}`;
    }
  },
});

/**
 * Journey count tool - calculates journey counts from geofencing data
 */
export const journeyCountTool = tool({
  name: 'journey_count_tool',
  description: `Calculate journey counts. For "how many journeys" questions only.

SQL MUST use: device_geofencings dg, JOIN user_device_assignment uda ON uda.device = dg.device_id
Select: dg.device_id, dg.facility_id, dg.facility_type, dg.entry_event_time, dg.exit_event_time
Order: ORDER BY dg.entry_event_time ASC

This tool:
1. Executes SQL to fetch raw geofencing rows
2. Runs journey count algorithm in TypeScript
3. Returns journey counts by facility pair`,
  parameters: z.object({
    sql: z.string().describe('SELECT query to fetch geofencing rows. MUST NOT include LIMIT clause.'),
    params: z
      .object({
        extraJourneyTimeLimit: z.number().nullable().optional().describe('Extra hours for same-facility journey validation'),
      })
      .nullable()
      .optional()
      .describe('Optional parameters for journey calculation'),
  }),
  execute: async ({ sql, params }: { sql: string; params?: { extraJourneyTimeLimit?: number | null } | null }) => {
    const toolCallId = `tool_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    logger.info(`🔧 TOOL CALLED: journey_count_tool [${toolCallId}]`, {
      toolCallId,
      sqlQuery: sql,
      params,
      timestamp: new Date().toISOString(),
    });

    try {
      // Validate SQL is SELECT only
      const sqlUpper = sql.trim().toUpperCase();
      if (!sqlUpper.startsWith('SELECT')) {
        const errorMsg = 'Only SELECT queries are allowed for journey calculations';
        logger.error(`   ❌ ${errorMsg}`);
        return errorMsg;
      }

      // Execute query
      const result = await databaseService.executeQuery(sql, true);

      if (!result || result.rowCount === 0) {
        logger.info('   Result: No geofencing rows returned');
        return JSON.stringify({
          counts: {},
          total: 0,
        });
      }

      // Parse query results into list of dicts
      const geofencingRows = parseSqlResultToGeofencingRows(result.rows);

      logger.info(`   Parsed ${geofencingRows.length} geofencing rows from SQL result`);

      if (geofencingRows.length === 0) {
        logger.warn('   ⚠️ WARNING: SQL returned data but parsing failed!');
        return JSON.stringify({
          error: 'Failed to parse SQL results',
          counts: {},
          total: 0,
        });
      }

      // Extract extraJourneyTimeLimit from params
      const extraJourneyTimeLimit = params?.extraJourneyTimeLimit || null;

      // Run journey calculation
      logger.info(`   Processing ${geofencingRows.length} geofencing rows with journey algorithm...`);
      const journeyResult = calculateJourneyCounts(geofencingRows, extraJourneyTimeLimit);

      // Log metadata for debugging
      const metadata = journeyResult.metadata;
      if (metadata) {
        logger.info(
          `   📊 Metadata: ${metadata.total_rows_processed} rows, ${metadata.devices_processed} devices, facility types: ${metadata.facility_types_found.join(', ')}`
        );
      }

      // Format result
      const resultJson = JSON.stringify(journeyResult, null, 2);

      const totalJourneys = journeyResult.total;
      logger.info(`   ✅ Calculated ${totalJourneys} total journeys`);
      logger.info(`   Found ${Object.keys(journeyResult.counts).length} unique facility pairs`);

      if (totalJourneys === 0 && geofencingRows.length > 0) {
        logger.warn(
          `   ⚠️ NOTE: Found ${geofencingRows.length} geofencing records but 0 journeys. This could mean: same facility only, or journey time < 4 hours`
        );
      }

      return resultJson;
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      const errorStack = error?.stack || 'No stack trace available';
      logger.error(`❌ Journey count calculation error:`, {
        message: errorMessage,
        stack: errorStack,
        error: error,
      });
      return `Error calculating journey counts: ${errorMessage}`;
    }
  },
});

/**
 * Get area bounds tool - fetches geographic polygon for a location from OpenStreetMap
 */
export const getAreaBoundsTool = tool({
  name: 'get_area_bounds',
  description: `Get the geographic polygon (bounding box) for a location from OpenStreetMap.
  
Use this tool when the user asks about a specific location (city, state, country, region) and you need
to generate a POLYGON or MULTIPOLYGON for geographic filtering in SQL queries.

IMPORTANT: Pass structured location parameters for accurate results:
- For countries: use { country: "United States" } or { country: "Mexico" }
- For states: use { state: "California" } or { state: "Texas" }
- For cities: use { city: "New York" } or { city: "Los Angeles" }
- For general queries: use { q: "location name" } as fallback
- You can combine parameters: { country: "United States", state: "California" }

Examples:
- "devices in United States" -> { country: "United States" }
- "shipments in California" -> { state: "California" }
- "facilities in New York" -> { city: "New York" } or { state: "New York" }
- "journeys in Mexico" -> { country: "Mexico" }

The tool will:
1. Query OpenStreetMap API with proper parameters
2. Extract all polygons from the GeoJSON response (handles both Polygon and MultiPolygon)
3. Simplify each polygon separately to reduce complexity
4. Return a structured JSON response with:
   - success: boolean indicating if the operation succeeded
   - location: the location parameters that were queried
   - bounding_box: object with min_latitude, max_latitude, min_longitude, max_longitude
   - polygon: object containing:
     - geometry_type: "Polygon" or "MultiPolygon" indicating the geometry type
     - postgres_format: the POLYGON or MULTIPOLYGON string ready for PostgreSQL (use this in SQL queries)
     - points_count: original and simplified point counts, plus polygons_count for MultiPolygon
     - coordinates: array of [longitude, latitude] pairs
   - usage: SQL example showing how to use the polygon

To use the result:
- Parse the JSON response
- Extract polygon.postgres_format field (may be POLYGON or MULTIPOLYGON format)
- Use it directly in your SQL query with ST_Contains or ST_Within
- Note: For locations with multiple disconnected areas (e.g., countries with islands like Mexico), 
  the tool returns MULTIPOLYGON format which includes all regions for accurate results

If the tool fails to find the location, it will return success: false with error details and suggestions.`,
  parameters: z.object({
    country: z.string().nullable().optional().describe('Country name (e.g., "United States", "Mexico", "India")'),
    state: z.string().nullable().optional().describe('State/Province name (e.g., "California", "Texas", "New York")'),
    city: z.string().nullable().optional().describe('City name (e.g., "New York", "Los Angeles", "Mumbai")'),
    county: z.string().nullable().optional().describe('County name'),
    street: z.string().nullable().optional().describe('Street name'),
    postalcode: z.string().nullable().optional().describe('Postal/ZIP code'),
    q: z.string().nullable().optional().describe('General query string (use as fallback if specific parameters not available)'),
    countrycodes: z.string().nullable().optional().describe('ISO 3166-1alpha2 country codes (e.g., "us", "mx", "in")'),
    polygon_threshold: z.number().nullable().optional().describe('Polygon simplification threshold (0.0-1.0, default: 0.1)'),
    limit: z.number().nullable().optional().describe('Maximum number of results (default: 1)'),
  }),
  execute: async (params: {
    country?: string | null;
    state?: string | null;
    city?: string | null;
    county?: string | null;
    street?: string | null;
    postalcode?: string | null;
    q?: string | null;
    countrycodes?: string | null;
    polygon_threshold?: number | null;
    limit?: number | null;
  }) => {
    logger.info(`🔧 TOOL CALLED: get_area_bounds`);
    
    // Filter out null values and create clean params object
    const cleanParams: Record<string, string | number> = {};
    if (params.country != null) cleanParams.country = params.country;
    if (params.state != null) cleanParams.state = params.state;
    if (params.city != null) cleanParams.city = params.city;
    if (params.county != null) cleanParams.county = params.county;
    if (params.street != null) cleanParams.street = params.street;
    if (params.postalcode != null) cleanParams.postalcode = params.postalcode;
    if (params.q != null) cleanParams.q = params.q;
    if (params.countrycodes != null) cleanParams.countrycodes = params.countrycodes;
    if (params.polygon_threshold != null) cleanParams.polygon_threshold = params.polygon_threshold;
    if (params.limit != null) cleanParams.limit = params.limit;
    
    logger.info(`   Parameters:`, cleanParams);

    try {
      // Build OpenStreetMap Nominatim API URL with proper parameters
      const apiParams = new URLSearchParams();
      
      // Add structured parameters (prioritize specific over general)
      if (params.country) {
        apiParams.append('country', params.country);
      }
      if (params.state) {
        apiParams.append('state', params.state);
      }
      if (params.city) {
        apiParams.append('city', params.city);
      }
      if (params.county) {
        apiParams.append('county', params.county);
      }
      if (params.street) {
        apiParams.append('street', params.street);
      }
      if (params.postalcode) {
        apiParams.append('postalcode', params.postalcode);
      }
      if (params.countrycodes) {
        apiParams.append('countrycodes', params.countrycodes);
      }
      
      // Use 'q' parameter only if no specific parameters provided
      if (!params.country && !params.state && !params.city && !params.county && !params.street && params.q) {
        apiParams.append('q', params.q);
      } else if (params.q && (params.country || params.state || params.city)) {
        // If both specific params and q are provided, q is ignored (specific params take precedence)
        logger.info(`   ⚠️  Both specific parameters and 'q' provided, using specific parameters only`);
      }
      
      // Add required/default parameters
      apiParams.append('format', 'json');
      apiParams.append('polygon_geojson', '1');
      apiParams.append('polygon_threshold', String(params.polygon_threshold || 0.5));
      apiParams.append('limit', String(params.limit || 1));
      apiParams.append('addressdetails', '1');
      
      const apiUrl = `https://nominatim.openstreetmap.org/search?${apiParams.toString()}`;
      
      logger.info(`   📡 Calling OpenStreetMap API: ${apiUrl}`);

      const response = await fetch(apiUrl, {
        headers: {
          // 1. Identify your specific app clearly
          'User-Agent': `Shipmentia_App_v1.0 (Contact: mehul@shipmentia.com)`,
          
          // 2. Mimic the Browser's "Accept" header 
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          
          // 3. Sec-Fetch headers (Crucial to bypass modern WAFs)
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1'
        }
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        logger.error(`   ❌ API Error: Status ${response.status}, Response: ${errorText}`);
        throw new Error(`OpenStreetMap API returned status ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      
      logger.info(`   📥 API Response received: ${Array.isArray(data) ? data.length : 'not array'} results`);

      if (!Array.isArray(data) || data.length === 0) {
        const locationDesc = params.country || params.state || params.city || params.q || 'unknown location';
        logger.warn(`   ⚠️  No results found for location:`, params);
        logger.warn(`   Response data: ${JSON.stringify(data).substring(0, 200)}`);
        return JSON.stringify({
          success: false,
          location: cleanParams,
          error: `No results found for the specified location`,
          suggestions: [
            "Use more specific location parameters (e.g., use 'country' for countries, 'state' for states)",
            "Try different parameter combinations",
            "Generate the POLYGON manually using known coordinates",
            "Inform the user that the area boundary could not be determined",
          ],
        }, null, 2);
      }

      const result = data[0];
      const locationName = result.display_name || result.name || cleanParams.country || cleanParams.state || cleanParams.city || cleanParams.q || 'unknown';
      logger.info(`   📍 Found location: ${locationName}`);
      
      // Extract bounding box from API response (only for reference/logging, not for polygon generation)
      // const boundingBox = result.boundingbox;
      // logger.info(`   📦 Has boundingBox: ${!!boundingBox}`);
      
      const geojson = result.geojson;
      logger.info(`   📦 Has geojson: ${!!geojson}`);

      // Extract coordinates from geojson ONLY (do not use bounding box - it has too few points)
      let rawCoordinates: number[][] = [];
      
      if (!geojson || !geojson.coordinates) {
        logger.error(`   ❌ No geojson coordinates available for location:`, cleanParams);
        return JSON.stringify({
          success: false,
          location: cleanParams,
          error: "No geojson coordinates available in API response. GeoJSON is required for accurate polygon generation.",
          suggestions: [
            "Try a more specific location name",
            "Generate the POLYGON manually using known coordinates",
            "Inform the user that the area boundary could not be determined",
          ],
        }, null, 2);
      }
      
      logger.info(`   🗺️  GeoJSON type: ${geojson.type}`);
      
      // Variables to store processed polygons
      let allPolygons: number[][][] = [];
      let geometryType: 'Polygon' | 'MultiPolygon' = 'Polygon';
      let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
      
      try {
        // Handle MultiPolygon: process ALL polygons, not just the first one
        if (geojson.type === 'MultiPolygon' && Array.isArray(geojson.coordinates)) {
          geometryType = 'MultiPolygon';
          // Process each polygon in the MultiPolygon
          for (const polygon of geojson.coordinates) {
            if (polygon && Array.isArray(polygon[0])) {
              const outerRing = polygon[0]; // First ring is outer boundary
              allPolygons.push(outerRing);
              // Calculate bounding box from all coordinates
              outerRing.forEach((coord: any) => {
                const lon = typeof coord[0] === 'number' ? coord[0] : parseFloat(String(coord[0]));
                const lat = typeof coord[1] === 'number' ? coord[1] : parseFloat(String(coord[1]));
                if (!isNaN(lon) && !isNaN(lat)) {
                  minLon = Math.min(minLon, lon);
                  maxLon = Math.max(maxLon, lon);
                  minLat = Math.min(minLat, lat);
                  maxLat = Math.max(maxLat, lat);
                }
              });
            }
          }
          logger.info(`   ✅ Extracted MultiPolygon: ${allPolygons.length} polygons`);
        } 
        // Handle Polygon: coordinates[0] is the outer ring
        else if (geojson.type === 'Polygon' && Array.isArray(geojson.coordinates)) {
          geometryType = 'Polygon';
          const outerRing = geojson.coordinates[0] || [];
          allPolygons.push(outerRing);
          // Calculate bounding box
          outerRing.forEach((coord: any) => {
            const lon = typeof coord[0] === 'number' ? coord[0] : parseFloat(String(coord[0]));
            const lat = typeof coord[1] === 'number' ? coord[1] : parseFloat(String(coord[1]));
            if (!isNaN(lon) && !isNaN(lat)) {
              minLon = Math.min(minLon, lon);
              maxLon = Math.max(maxLon, lon);
              minLat = Math.min(minLat, lat);
              maxLat = Math.max(maxLat, lat);
            }
          });
          logger.info(`   ✅ Extracted Polygon: ${outerRing.length} points`);
        }
        // Handle LineString or other types
        else if (Array.isArray(geojson.coordinates) && geojson.coordinates.length > 0) {
          const firstCoord = geojson.coordinates[0];
          if (Array.isArray(firstCoord) && typeof firstCoord[0] === 'number') {
            allPolygons.push(geojson.coordinates as number[][]);
            // Calculate bounding box
            (geojson.coordinates as number[][]).forEach((coord: any) => {
              const lon = typeof coord[0] === 'number' ? coord[0] : parseFloat(String(coord[0]));
              const lat = typeof coord[1] === 'number' ? coord[1] : parseFloat(String(coord[1]));
              if (!isNaN(lon) && !isNaN(lat)) {
                minLon = Math.min(minLon, lon);
                maxLon = Math.max(maxLon, lon);
                minLat = Math.min(minLat, lat);
                maxLat = Math.max(maxLat, lat);
              }
            });
            logger.info(`   ✅ Extracted LineString/other: ${geojson.coordinates.length} points`);
          }
        }
      } catch (geoError: any) {
        logger.warn(`   ⚠️  Error extracting geojson coordinates: ${geoError?.message}`);
      }

      // Require geojson coordinates - do not fallback to bounding box (it has too few points)
      if (allPolygons.length === 0) {
        logger.error(`   ❌ Failed to extract coordinates from geojson for location:`, cleanParams);
        return JSON.stringify({
          success: false,
          location: cleanParams,
          error: "Failed to extract coordinates from geojson. GeoJSON structure may be unsupported.",
          suggestions: [
            "Try a more specific location name",
            "Generate the POLYGON manually using known coordinates",
            "Inform the user that the area boundary could not be determined",
          ],
        }, null, 2);
      }
      
      // If no valid coordinates found, use defaults
      if (minLat === Infinity) {
        minLat = maxLat = minLon = maxLon = 0;
      }

      // Simplify each polygon separately and build WKT format
      const tolerance = 0.05; // Adjust this value to control simplification level
      const allSimplifiedPolygons: Array<Array<{x: number, y: number}>> = [];
      let totalOriginalPoints = 0;
      let totalSimplifiedPoints = 0;

      for (const polygon of allPolygons) {
        // Convert coordinates to simplify-js format: {x, y}
        // Note: OpenStreetMap uses [longitude, latitude] format
        const points = polygon.map((coord: any) => ({ 
          x: parseFloat(coord[0]), // longitude
          y: parseFloat(coord[1])  // latitude
        }));

        totalOriginalPoints += points.length;

        // Simplify polygon using simplify-js
        // tolerance: higher value = fewer points (0.01 degrees ≈ 1km, 0.1 degrees ≈ 11km)
        // highQuality: true = better quality but slower
        const simplifiedPoints = simplify(points, tolerance, true);
        allSimplifiedPolygons.push(simplifiedPoints);
        totalSimplifiedPoints += simplifiedPoints.length;
      }

      logger.info(`   📊 Original polygons have ${totalOriginalPoints} total points`);
      logger.info(`   ✂️  Simplified polygons to ${totalSimplifiedPoints} total points (tolerance: ${tolerance})`);

      // Build PostgreSQL WKT format
      let postgresPolygon: string;
      let allCoordinates: number[][];
      
      if (geometryType === 'MultiPolygon') {
        // Build MULTIPOLYGON WKT format: MULTIPOLYGON(((lon1 lat1, lon2 lat2, ...)), ((lon1 lat1, ...)))
        const polygonStrings = allSimplifiedPolygons.map(points => {
          const pointString = points.map((p: any) => `${p.x} ${p.y}`).join(', ');
          return `((${pointString}))`;
        });
        postgresPolygon = `MULTIPOLYGON(${polygonStrings.join(', ')})`;
        // Flatten all coordinates for response
        allCoordinates = allSimplifiedPolygons.flatMap(points => 
          points.map((p: any) => [p.x, p.y])
        );
      } else {
        // Single polygon - use POLYGON format
        const simplifiedPoints = allSimplifiedPolygons[0];
        const polygonString = simplifiedPoints
          .map((p: any) => `${p.x} ${p.y}`) // Format: "lon lat"
          .join(', ');
        postgresPolygon = `POLYGON((${polygonString}))`;
        allCoordinates = simplifiedPoints.map((p: any) => [p.x, p.y]);
      }

      const locationDesc = locationName;
      const geometryTypeName = geometryType === 'MultiPolygon' ? 'MULTIPOLYGON' : 'POLYGON';
      logger.info(`   ✅ Generated ${geometryTypeName} for ${locationDesc}`);
      logger.info(`   Bounding Box: [${minLat}, ${maxLat}, ${minLon}, ${maxLon}]`);
      logger.info(`   Points: ${totalOriginalPoints} → ${totalSimplifiedPoints} (simplified)`);
      logger.info(`   ${geometryTypeName}: ${postgresPolygon.substring(0, 100)}...`);

      // Return structured JSON response for easier LLM handling
      return JSON.stringify({
        success: true,
        location: cleanParams,
        location_name: locationName,
        bounding_box: {
          min_latitude: minLat,
          max_latitude: maxLat,
          min_longitude: minLon,
          max_longitude: maxLon,
        },
        polygon: {
          geometry_type: geometryType, // 'Polygon' or 'MultiPolygon'
          postgres_format: postgresPolygon,
          points_count: {
            original: totalOriginalPoints,
            simplified: totalSimplifiedPoints,
            polygons_count: allSimplifiedPolygons.length,
          },
          coordinates: allCoordinates, // [longitude, latitude] pairs
        },
        usage: {
          sql_example: `WHERE ST_Contains(
              ST_GeomFromText('${postgresPolygon}', 4326),
              ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
          )`,
          note: "Use the polygon.postgres_format field directly in your SQL query with ST_Contains or ST_Within. The format may be POLYGON or MULTIPOLYGON depending on the location.",
        },
      }, null, 2);
    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      logger.error(`❌ Error getting area bounds for location:`, {
        params: cleanParams,
        message: errorMessage,
        error: error,
      });
      
      // Return structured JSON error response
      return JSON.stringify({
        success: false,
        location: cleanParams,
        error: errorMessage,
        suggestions: [
          "Use proper location parameters (e.g., 'country' for countries, 'state' for states, 'city' for cities)",
          "Try different parameter combinations",
          "Generate the POLYGON manually using known coordinates",
          "Inform the user that the area boundary could not be determined",
        ],
      }, null, 2);
    }
  },
});
