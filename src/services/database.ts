import { sequelizeReadOnly, QUERY_TIMEOUT_SECONDS } from '../config/database';
import { QueryTypes } from 'sequelize';
import { logger } from '../utils/logger';

export interface QueryResult {
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  formatted: string;
}

/**
 * Database Service for SQL Query Execution
 */
export class DatabaseService {
  /**
   * Execute a SQL query and return formatted results
   */
  async executeQuery(query: string, includeColumns: boolean = true): Promise<QueryResult | null> {
    try {
      // Set statement timeout for this transaction
      await sequelizeReadOnly.query(
        `SET LOCAL statement_timeout = ${QUERY_TIMEOUT_SECONDS * 1000}`,
        { type: QueryTypes.RAW }
      );

      // Execute the actual query
      const results = await sequelizeReadOnly.query(query, {
        type: QueryTypes.SELECT,
      }) as any[];

      if (!results || results.length === 0) {
        return {
          columns: [],
          rows: [],
          rowCount: 0,
          formatted: '',
        };
      }

      // Extract columns from first row
      const columns = Object.keys(results[0]);
      const rows = results;

      // Format as pipe-separated string (similar to SQLDatabase format)
      let formatted = '';
      if (includeColumns) {
        formatted = columns.join(' | ') + '\n';
      }

      for (const row of rows) {
        const values = columns.map((col) => String(row[col] || ''));
        formatted += values.join(' | ') + '\n';
      }

      return {
        columns,
        rows,
        rowCount: rows.length,
        formatted: formatted.trim(),
      };
    } catch (error: any) {
      // Check if it's a timeout error
      const errorStr = String(error).toLowerCase();
      if (
        errorStr.includes('timeout') ||
        errorStr.includes('statement_timeout') ||
        errorStr.includes('canceling statement')
      ) {
        logger.error(`Query timeout after ${QUERY_TIMEOUT_SECONDS} seconds: ${query.substring(0, 100)}...`);
        throw new Error(`Query timeout: Query exceeded ${QUERY_TIMEOUT_SECONDS} seconds`);
      }

      logger.error(`Query execution error: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a query without throwing errors (returns null on error)
   */
  async executeQueryNoThrow(
    query: string,
    includeColumns: boolean = true
  ): Promise<QueryResult | null> {
    try {
      return await this.executeQuery(query, includeColumns);
    } catch (error) {
      logger.error(`Query execution failed (no throw): ${error}`);
      return null;
    }
  }

  /**
   * Detect query type (COUNT, LIST, or OTHER)
   */
  detectQueryType(query: string): 'count' | 'list' | 'other' {
    const queryUpper = query.toUpperCase().trim();

    // Check for COUNT queries
    if (
      queryUpper.includes('COUNT(') ||
      queryUpper.includes('SUM(') ||
      queryUpper.includes('AVG(') ||
      queryUpper.includes('MAX(') ||
      queryUpper.includes('MIN(')
    ) {
      // If it's a simple aggregation (no GROUP BY), it's a count query
      if (!queryUpper.includes('GROUP BY')) {
        return 'count';
      }
    }

    // Check for LIST queries (SELECT with potential LIMIT)
    if (queryUpper.startsWith('SELECT')) {
      return 'list';
    }

    return 'other';
  }

  /**
   * Execute a COUNT query and return only the count value
   */
  async executeCountQuery(query: string): Promise<string> {
    try {
      const result = await this.executeQuery(query, true);
      if (!result || result.rowCount === 0) {
        return '0';
      }

      // For COUNT queries, return the first value from the first row
      if (result.rows.length > 0) {
        const firstRow = result.rows[0];
        const firstValue = Object.values(firstRow)[0];
        return String(firstValue || '0');
      }

      return '0';
    } catch (error) {
      logger.error(`Count query execution error: ${error}`);
      throw error;
    }
  }

  /**
   * Execute a LIST query without adding LIMIT clause
   * CSV generation handles limiting in the tool response
   */
  async executeListQuery(query: string, limit: number = 3): Promise<QueryResult | null> {
    try {
      const result = await this.executeQuery(query, true);
      return result;
    } catch (error) {
      logger.error(`List query execution error: ${error}`);
      throw error;
    }
  }
}
