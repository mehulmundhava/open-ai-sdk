/**
 * Custom Script Runner Service
 *
 * Executes LLM-generated JavaScript code in a sandboxed vm context.
 * The script can call `await runQuery(sql)` to fetch data from the database,
 * enabling complex multi-table logic that can't be expressed in a single SQL query.
 *
 * Security:
 * - Read-only DB access (uses sequelizeReadOnly)
 * - Only SELECT queries allowed
 * - 30-second execution timeout
 * - No filesystem, network, process, or require access
 * - Isolated vm.runInNewContext() sandbox
 */

import vm from 'vm';
import { DatabaseService, QueryResult } from './database';
import { logger } from '../utils/logger';

const SCRIPT_TIMEOUT_MS = 30_000; // 30 seconds
const MAX_QUERIES_PER_SCRIPT = 20;
const MAX_RESULT_SIZE = 500_000; // 500KB max result size

export interface ScriptResult {
    success: boolean;
    data: any;
    logs: string[];
    error?: string;
    queriesExecuted: number;
    executionTimeMs: number;
}

/**
 * Validate that a SQL query is safe to execute (SELECT only).
 */
function validateSqlQuery(sql: string): { valid: boolean; error?: string } {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // Must start with SELECT or WITH (CTEs)
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        return { valid: false, error: `Only SELECT queries are allowed. Got: ${trimmed.substring(0, 50)}...` };
    }

    // Block dangerous keywords that shouldn't appear in read-only queries
    const dangerousKeywords = [
        /\bINSERT\s+INTO\b/i,
        /\bUPDATE\s+\w+\s+SET\b/i,
        /\bDELETE\s+FROM\b/i,
        /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW|SCHEMA)\b/i,
        /\bTRUNCATE\b/i,
        /\bALTER\s+(TABLE|DATABASE|INDEX|VIEW|SCHEMA)\b/i,
        /\bCREATE\s+(TABLE|DATABASE|INDEX|VIEW|SCHEMA)\b/i,
        /\bGRANT\b/i,
        /\bREVOKE\b/i,
        /\bEXECUTE\b/i,
    ];

    for (const pattern of dangerousKeywords) {
        if (pattern.test(trimmed)) {
            return { valid: false, error: `Query contains dangerous keyword: ${pattern.source}` };
        }
    }

    return { valid: true };
}

/**
 * Execute a custom script in a sandboxed vm context.
 *
 * The script has access to:
 * - `await runQuery(sql)` — execute a read-only SQL query, returns { columns, rows, rowCount }
 * - `console.log(...)` — captured to log buffer
 * - Safe globals: JSON, Math, Date, Array, Object, String, Number, parseInt, parseFloat, isNaN, isFinite
 *
 * The script MUST set a global variable called `result` with the final output.
 */
export async function executeCustomScript(code: string): Promise<ScriptResult> {
    const startTime = Date.now();
    const logs: string[] = [];
    let queriesExecuted = 0;
    const databaseService = new DatabaseService();

    logger.info('🔧 Custom Script Runner: Starting script execution', {
        codeLength: code.length,
        codePreview: code.substring(0, 200),
    });

    // Validate code doesn't try to escape sandbox
    const sandboxEscapePatterns = [
        /\brequire\s*\(/,
        /\bimport\s+/,
        /\bprocess\b/,
        /\bglobal\b/,
        /\bglobalThis\b/,
        /\b__dirname\b/,
        /\b__filename\b/,
        /\bchild_process\b/,
        /\beval\s*\(/,
        /\bFunction\s*\(/,
        /\bconstructor\b.*\bconstructor\b/,
        /this\.constructor/,
    ];

    for (const pattern of sandboxEscapePatterns) {
        if (pattern.test(code)) {
            const error = `Script contains prohibited pattern: ${pattern.source}`;
            logger.warn(`🔧 Custom Script Runner: BLOCKED - ${error}`);
            return {
                success: false,
                data: null,
                logs,
                error,
                queriesExecuted: 0,
                executionTimeMs: Date.now() - startTime,
            };
        }
    }

    // Create sandboxed runQuery function
    const runQuery = async (sql: string): Promise<{ columns: string[]; rows: Record<string, any>[]; rowCount: number }> => {
        // Check query limit
        if (queriesExecuted >= MAX_QUERIES_PER_SCRIPT) {
            throw new Error(`Maximum query limit reached (${MAX_QUERIES_PER_SCRIPT}). Optimize your script to use fewer queries.`);
        }

        // Validate SQL
        const validation = validateSqlQuery(sql);
        if (!validation.valid) {
            throw new Error(validation.error);
        }

        queriesExecuted++;
        logger.info(`🔧 Custom Script Runner: Executing query #${queriesExecuted}`, {
            sqlPreview: sql.substring(0, 150),
        });

        try {
            const result = await databaseService.executeQuery(sql, true);

            if (!result || result.rowCount === 0) {
                return { columns: [], rows: [], rowCount: 0 };
            }

            return {
                columns: result.columns,
                rows: result.rows,
                rowCount: result.rowCount,
            };
        } catch (error: any) {
            const errorMessage = error?.message || String(error);
            logger.error(`🔧 Custom Script Runner: Query #${queriesExecuted} failed: ${errorMessage}`);
            throw new Error(`Query execution failed: ${errorMessage}`);
        }
    };

    // Create sandbox context with safe globals only
    const sandbox: Record<string, any> = {
        // The query function
        runQuery,

        // Result variable — script must set this
        result: undefined,

        // Logging
        console: {
            log: (...args: any[]) => {
                const msg = args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
                logs.push(msg);
                logger.debug(`🔧 Script console.log: ${msg}`);
            },
            warn: (...args: any[]) => {
                const msg = args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
                logs.push(`[WARN] ${msg}`);
            },
            error: (...args: any[]) => {
                const msg = args.map((a: any) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
                logs.push(`[ERROR] ${msg}`);
            },
        },

        // Safe built-ins
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        Map,
        Set,
        RegExp,
        Error,
        Promise,
        parseInt,
        parseFloat,
        isNaN,
        isFinite,
        undefined,
        null: null,
        true: true,
        false: false,
        Infinity,
        NaN,
    };

    try {
        // Wrap the code in an async IIFE so await works at the top level
        const wrappedCode = `
      (async () => {
        ${code}
      })();
    `;

        // Create the vm context
        const context = vm.createContext(sandbox);

        // Compile and run the script
        const script = new vm.Script(wrappedCode, {
            filename: 'custom_script.js',
        });

        // Run and await the async result (timeout applies to synchronous portion)
        const scriptPromise = script.runInContext(context, {
            timeout: SCRIPT_TIMEOUT_MS,
        });

        // Wrap with timeout for the async portion
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error(`Script execution timed out after ${SCRIPT_TIMEOUT_MS / 1000} seconds`)), SCRIPT_TIMEOUT_MS);
        });

        await Promise.race([scriptPromise, timeoutPromise]);

        // Get result from sandbox
        const scriptResult = sandbox.result;

        if (scriptResult === undefined) {
            logger.warn('🔧 Custom Script Runner: Script completed but no result variable set');
            return {
                success: false,
                data: null,
                logs,
                error: 'Script completed but did not set the `result` variable. The script must assign the final output to `result`.',
                queriesExecuted,
                executionTimeMs: Date.now() - startTime,
            };
        }

        // Check result size
        const resultStr = JSON.stringify(scriptResult);
        if (resultStr && resultStr.length > MAX_RESULT_SIZE) {
            logger.warn(`🔧 Custom Script Runner: Result too large (${resultStr.length} bytes), truncating`);
            return {
                success: true,
                data: {
                    note: `Result was too large (${resultStr.length} bytes). Showing summary only.`,
                    totalItems: Array.isArray(scriptResult) ? scriptResult.length : 'N/A',
                    preview: Array.isArray(scriptResult) ? scriptResult.slice(0, 10) : scriptResult,
                },
                logs,
                queriesExecuted,
                executionTimeMs: Date.now() - startTime,
            };
        }

        logger.info('🔧 Custom Script Runner: Script completed successfully', {
            queriesExecuted,
            resultType: typeof scriptResult,
            resultLength: Array.isArray(scriptResult) ? scriptResult.length : 'N/A',
            executionTimeMs: Date.now() - startTime,
        });

        return {
            success: true,
            data: scriptResult,
            logs,
            queriesExecuted,
            executionTimeMs: Date.now() - startTime,
        };
    } catch (error: any) {
        const errorMessage = error?.message || String(error);
        const executionTimeMs = Date.now() - startTime;

        logger.error('🔧 Custom Script Runner: Script execution failed', {
            error: errorMessage,
            stack: error?.stack,
            queriesExecuted,
            executionTimeMs,
        });

        return {
            success: false,
            data: null,
            logs,
            error: errorMessage,
            queriesExecuted,
            executionTimeMs,
        };
    }
}
