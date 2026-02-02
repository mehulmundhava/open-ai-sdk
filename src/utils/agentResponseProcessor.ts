/**
 * Agent Response Processor
 * 
 * Handles extraction, processing, and logging of agent responses including:
 * - Tool call extraction and execution
 * - Token usage tracking
 * - SQL query extraction
 * - Structured logging with proper tool names and token consumption
 */

import { logger } from './logger';
import { TokenTracker, TokenUsage } from './tokenTracker';

export interface ToolCallInfo {
  tool: string;
  input?: any;
  output?: any;
  error?: any;
  hasError?: boolean;
  tokens?: TokenUsage;
}

export interface ProcessedAgentResult {
  answer: string;
  sqlQuery?: string;
  queryResult?: string;
  csvId?: string;
  csvDownloadPath?: string;
  toolCalls: ToolCallInfo[];
  toolErrors: Array<{
    tool: string;
    error: string;
    input?: any;
  }>;
}

export class AgentResponseProcessor {
  private tokenTracker: TokenTracker;
  private userId: string;
  private question: string;

  constructor(tokenTracker: TokenTracker, userId: string, question: string) {
    this.tokenTracker = tokenTracker;
    this.userId = userId;
    this.question = question;
  }

  /**
   * Process agent result and extract all relevant information
   */
  async processResult(result: any): Promise<ProcessedAgentResult> {
    // Check for errors first
    this.checkForErrors(result);

    // Extract tool calls
    const toolCalls = await this.extractToolCalls(result);

    // Extract token usage
    this.extractTokenUsage(result, toolCalls);

    // Extract answer
    const answer = this.extractAnswer(result);

    // Extract SQL query and results
    const { sqlQuery, queryResult, csvId, csvDownloadPath } = await this.extractQueryInfo(
      toolCalls,
      answer
    );

    // Extract tool errors
    const toolErrors = this.extractToolErrors(toolCalls);

    // Log comprehensive summary
    this.logSummary(answer, sqlQuery, toolCalls, queryResult);

    return {
      answer,
      sqlQuery,
      queryResult,
      csvId,
      csvDownloadPath,
      toolCalls,
      toolErrors,
    };
  }

  /**
   * Check for errors in the result
   */
  private checkForErrors(result: any): void {
    if ('error' in result && result.error) {
      const errorObj = result.error as any;
      const errorDetails = {
        message: errorObj?.message || String(result.error),
        stack: errorObj?.stack,
      };
      logger.error('❌ Agent execution error:', errorDetails);
      throw new Error(`Agent execution failed: ${errorDetails.message}`);
    }
  }

  /**
   * Extract tool calls from various locations in the result
   */
  async extractToolCalls(result: any): Promise<ToolCallInfo[]> {
    const toolCalls: ToolCallInfo[] = [];
    const resultAny = result as any;

    logger.debug('🔍 Extracting tool calls from result structure', {
      hasSteps: 'steps' in result,
      hasState: !!resultAny.state,
      hasModelResponses: !!resultAny.state?.modelResponses,
      hasToolCalls: !!resultAny.state?.toolCalls,
      hasToolResults: !!resultAny.state?.toolResults,
    });

    // Method 1: Extract from steps array
    if ('steps' in result && Array.isArray(result.steps)) {
      logger.debug(`   Method 1: Found ${result.steps.length} steps`);
      this.extractFromSteps(result.steps, toolCalls);
    }

    // Method 2: Extract from state.modelResponses (OpenAI Agents SDK structure)
    if (resultAny.state?.modelResponses && Array.isArray(resultAny.state.modelResponses)) {
      logger.debug(`   Method 2: Found ${resultAny.state.modelResponses.length} model responses`);
      await this.extractFromModelResponses(resultAny.state.modelResponses, toolCalls);
    }

    // Method 3: Extract from executed tool calls in state
    if (resultAny.state?.toolCalls || resultAny.state?.toolResults) {
      const toolCallsCount = (resultAny.state.toolCalls || []).length;
      const toolResultsCount = (resultAny.state.toolResults || []).length;
      logger.debug(`   Method 3: Found ${toolCallsCount} toolCalls, ${toolResultsCount} toolResults`);
      this.extractFromStateToolCalls(resultAny.state, toolCalls);
    }

    // Method 4: Deep search for tool calls in state
    if (toolCalls.length === 0 && resultAny.state) {
      logger.debug('   Method 4: Deep searching state for tool calls');
      this.deepSearchToolCalls(resultAny.state, toolCalls);
    }

    logger.info(`✅ Extracted ${toolCalls.length} tool call(s)`, {
      tools: toolCalls.map(tc => tc.tool),
    });

    return toolCalls;
  }

  /**
   * Deep search for tool calls in state object
   */
  private deepSearchToolCalls(obj: any, toolCalls: ToolCallInfo[]): void {
    if (!obj || typeof obj !== 'object') return;

    // Check if this object looks like a tool call
    if ((obj.tool || obj.name) && (obj.input || obj.args || obj.arguments || obj.result || obj.output)) {
      const toolName = obj.tool?.name || obj.name || 'unknown';
      const toolInput = obj.input || obj.args || obj.arguments;
      const toolOutput = obj.result || obj.output;
      const toolError = obj.error;

      // Check if already added
      const exists = toolCalls.some(tc => 
        tc.tool === toolName && 
        JSON.stringify(tc.input) === JSON.stringify(toolInput)
      );

      if (!exists) {
        logger.debug(`   Found tool call in deep search: ${toolName}`);
        toolCalls.push({
          tool: toolName,
          input: toolInput,
          output: toolOutput,
          error: toolError,
          hasError: !!toolError || (typeof toolOutput === 'string' && toolOutput.toLowerCase().includes('error')),
        });
      }
    }

    // Recursively search nested objects
    for (const key in obj) {
      if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
        this.deepSearchToolCalls(obj[key], toolCalls);
      }
    }
  }

  /**
   * Extract tool calls from steps array
   */
  private extractFromSteps(steps: any[], toolCalls: ToolCallInfo[]): void {
    logger.debug('🔍 Extracting tool calls from steps array');
    for (const step of steps) {
      const stepAny = step as any;
      
      if (stepAny.type === 'tool-call' || stepAny.toolCall || stepAny.tool) {
        const toolName = stepAny.tool?.name || stepAny.toolCall?.tool?.name || 'unknown';
        const toolInput = stepAny.toolCall?.input || stepAny.input || stepAny.args;
        const toolOutput = stepAny.toolCall?.result || stepAny.result || stepAny.output;
        const toolError = stepAny.error || stepAny.toolCall?.error;
        
        toolCalls.push({
          tool: toolName,
          input: toolInput,
          output: toolOutput,
          error: toolError,
          hasError: !!toolError || (typeof toolOutput === 'string' && toolOutput.toLowerCase().includes('error')),
        });
      }
    }
  }

  /**
   * Extract tool calls from model responses and execute them if needed
   */
  private async extractFromModelResponses(
    modelResponses: any[],
    toolCalls: ToolCallInfo[]
  ): Promise<void> {
    logger.debug('🔍 Extracting tool calls from state.modelResponses');
    
    for (const modelResponse of modelResponses) {
      if (modelResponse.output && Array.isArray(modelResponse.output)) {
        for (const outputItem of modelResponse.output) {
          if (outputItem.providerData?.tool_calls && Array.isArray(outputItem.providerData.tool_calls)) {
            logger.info(`🔧 Found ${outputItem.providerData.tool_calls.length} tool call(s) in providerData`);
            
            for (const toolCall of outputItem.providerData.tool_calls) {
              try {
                const toolCallInfo = await this.parseAndExecuteToolCall(toolCall);
                if (toolCallInfo) {
                  toolCalls.push(toolCallInfo);
                }
              } catch (error: any) {
                logger.error(`Error parsing tool call: ${error.message}`);
              }
            }
          }
        }
      }
    }
  }

  /**
   * Parse and execute a tool call
   */
  private async parseAndExecuteToolCall(toolCall: any): Promise<ToolCallInfo | null> {
    const functionName = toolCall.function?.name || toolCall.name || 'unknown';
    const functionArgs = toolCall.function?.arguments || toolCall.arguments || '{}';
    
    // Parse arguments
    const parsedArgs = this.parseToolArguments(functionArgs);
    
    // Map function name to tool name
    const toolName = this.mapFunctionNameToTool(functionName, parsedArgs);
    
    // Handle journey tools (they use 'sql' parameter, not 'query')
    if (toolName === 'journey_list_tool' || toolName === 'journey_count_tool') {
      const sqlStr = parsedArgs.sql || '';
      if (sqlStr && typeof sqlStr === 'string') {
        logger.info(`📝 Journey tool SQL detected: ${toolName} - ${sqlStr.substring(0, 100)}`);
        // Journey tools are executed by the framework, so we just return the tool call info
        // The actual execution happens in the tool itself
        return {
          tool: toolName,
          input: parsedArgs,
          output: undefined, // Will be populated from state if available
          error: undefined,
          hasError: false,
        };
      }
    }
    
    // Extract and execute SQL query if present (for regular SQL tools)
    if (parsedArgs.query && typeof parsedArgs.query === 'string') {
      const queryStr: string = parsedArgs.query;
      logger.info(`📝 SQL Query detected in tool call: ${toolName} - ${queryStr.substring(0, 100)}`);
      
      try {
        const toolOutput = await this.executeQuery(toolName, queryStr);
        
        return {
          tool: toolName,
          input: parsedArgs,
          output: toolOutput,
          error: undefined,
          hasError: false,
        };
      } catch (error: any) {
        const errorMessage = error?.message || String(error);
        logger.error(`❌ Error executing query for tool ${toolName}:`, {
          error: errorMessage,
          stack: error?.stack,
        });
        
        return {
          tool: toolName,
          input: parsedArgs,
          output: undefined,
          error: errorMessage,
          hasError: true,
        };
      }
    }
    
    // For other tools without query/sql, just return the tool call info
    logger.debug(`Tool call detected: ${toolName}`, {
      functionName,
      arguments: parsedArgs,
    });
    
    return {
      tool: toolName,
      input: parsedArgs,
      output: undefined,
      error: undefined,
      hasError: false,
    };
  }

  /**
   * Parse tool arguments from various formats
   */
  private parseToolArguments(functionArgs: any): any {
    if (typeof functionArgs === 'object' && functionArgs !== null) {
      return functionArgs;
    }

    if (typeof functionArgs === 'string') {
      try {
        if (functionArgs.trim().startsWith('{') || functionArgs.trim().startsWith('[')) {
          return JSON.parse(functionArgs);
        } else {
          // Try to extract query from malformed JSON
          const queryMatch = functionArgs.match(/["']query["']\s*:\s*["']([^"']+)["']/);
          if (queryMatch) {
            return { query: queryMatch[1] };
          }
          return { raw: functionArgs };
        }
      } catch (e: any) {
        logger.warn(`Failed to parse tool arguments: ${functionArgs.substring(0, 100)}`);
        // Try to extract query from the raw string as fallback
        const queryMatch = functionArgs.match(/query["']?\s*[:=]\s*["']?([^"',}]+)["']?/i);
        if (queryMatch) {
          return { query: queryMatch[1].trim() };
        }
        return { raw: functionArgs };
      }
    }

    return { raw: functionArgs };
  }

  /**
   * Map OpenAI function names to our tool names
   */
  private mapFunctionNameToTool(functionName: string, parsedArgs: any): string {
    if (functionName === 'execute' || functionName === 'execute_db_query' || functionName === 'executeDbQuery') {
      const query = parsedArgs.query || '';
      if (query && typeof query === 'string') {
        const queryUpper = query.toUpperCase();
        if (queryUpper.includes('COUNT(') || queryUpper.includes('COUNT (')) {
          return 'count_query';
        } else if (queryUpper.includes('SELECT') && !queryUpper.includes('COUNT(')) {
          return 'list_query';
        }
      }
      return 'execute_db_query';
    } else if (functionName === 'count_query' || functionName === 'countQuery') {
      return 'count_query';
    } else if (functionName === 'list_query' || functionName === 'listQuery') {
      return 'list_query';
    }
    
    return functionName;
  }

  /**
   * Execute SQL query based on tool type
   */
  private async executeQuery(toolName: string, queryStr: string): Promise<any> {
    const { DatabaseService } = await import('../services/database');
    const dbService = new DatabaseService();
    
    logger.info(`🔧 Executing ${toolName} query`);
    
    if (toolName === 'count_query') {
      return await dbService.executeCountQuery(queryStr);
    } else if (toolName === 'list_query') {
      // Remove LIMIT clause if present
      let cleanedQuery = queryStr;
      if (queryStr.toUpperCase().trim().includes('LIMIT')) {
        logger.warn('⚠️  Removing LIMIT clause from query to get full results');
        cleanedQuery = queryStr.replace(/LIMIT\s+\d+/gi, '').trim().replace(/;\s*$/, '');
      }
      const result = await dbService.executeListQuery(cleanedQuery, 3);
      return result?.formatted || 'No results';
    } else {
      // execute_db_query or default
      const result = await dbService.executeQuery(queryStr, true);
      return result?.formatted || 'No results';
    }
  }

  /**
   * Extract tool calls from state.toolCalls or state.toolResults
   */
  private extractFromStateToolCalls(state: any, toolCalls: ToolCallInfo[]): void {
    logger.debug('🔍 Extracting executed tool calls from state');
    const executedCalls = state.toolCalls || state.toolResults || [];
    
    for (const executedCall of executedCalls) {
      const toolName = executedCall.tool?.name || executedCall.name || 'unknown';
      const toolInput = executedCall.input || executedCall.args || executedCall.arguments;
      const toolOutput = executedCall.result || executedCall.output;
      const toolError = executedCall.error;
      
      // Check if this tool call already exists (avoid duplicates)
      const existingCall = toolCalls.find(tc => 
        tc.tool === toolName && 
        JSON.stringify(tc.input) === JSON.stringify(toolInput)
      );
      
      if (!existingCall) {
        toolCalls.push({
          tool: toolName,
          input: toolInput,
          output: toolOutput,
          error: toolError,
          hasError: !!toolError || (typeof toolOutput === 'string' && toolOutput.toLowerCase().includes('error')),
        });
      } else {
        // Update existing call with output if available
        if (toolOutput && !existingCall.output) {
          existingCall.output = toolOutput;
        }
      }
    }
  }

  /**
   * Extract token usage from result and associate with tool calls
   */
  private extractTokenUsage(result: any, toolCalls: ToolCallInfo[]): void {
    const resultAny = result as any;
    let tokensExtracted = false;

    // Method 1: Check result.usage directly
    if ('usage' in result && result.usage) {
      tokensExtracted = this.recordTokenUsage('main_agent', result.usage);
    }

    // Method 2: Check state.modelResponses (ALWAYS check this for detailed usage with cached_tokens)
    // This is important because providerData.usage contains prompt_tokens_details with cached_tokens
    // We ALWAYS check this even if other methods found tokens, to ensure we capture all cached_tokens
    if (resultAny.state?.modelResponses && Array.isArray(resultAny.state.modelResponses)) {
      const modelResponseExtracted = this.extractTokensFromModelResponses(resultAny.state.modelResponses);
      tokensExtracted = tokensExtracted || modelResponseExtracted;
    }

    // Method 3: Check state.usage
    if (resultAny.state?.usage) {
      const stateUsageExtracted = this.recordTokenUsage('state_usage', resultAny.state.usage);
      tokensExtracted = tokensExtracted || stateUsageExtracted;
    }

    // Method 4: Check steps
    if ('steps' in result && Array.isArray(result.steps)) {
      const stepsExtracted = this.extractTokensFromSteps(result.steps);
      tokensExtracted = tokensExtracted || stepsExtracted;
    }

    // Method 5: Deep search in state (only if we haven't found anything yet, to avoid duplicates)
    // But we still want to check for providerData.usage in nested structures
    if (!tokensExtracted && resultAny.state) {
      tokensExtracted = this.deepSearchTokenUsage(resultAny.state);
    }

    if (!tokensExtracted) {
      logger.warn('⚠️  No token usage information found in any location');
    }

    // Log total token usage with breakdown
    this.logTokenUsageSummary(toolCalls);
  }

  /**
   * Record token usage for a stage
   */
  private recordTokenUsage(stage: string, usage: any): boolean {
    try {
      const tokens = TokenTracker.fromAgentsUsage(usage);
      this.tokenTracker.recordStage(stage, tokens);
      
      // Log cached tokens if available
      const cachedTokens = tokens.cachedTokens || tokens.promptTokensDetails?.cached_tokens || 0;
      const logData: any = {
        promptTokens: tokens.promptTokens,
        completionTokens: tokens.completionTokens,
        totalTokens: tokens.totalTokens,
      };
      
      if (cachedTokens > 0) {
        logData.cachedTokens = cachedTokens;
        logData.cacheHitRate = tokens.promptTokens > 0 
          ? `${((cachedTokens / tokens.promptTokens) * 100).toFixed(2)}%`
          : '0%';
      }
      
      logger.info(`💰 Token usage [${stage}]:`, logData);
      return true;
    } catch (error) {
      logger.warn(`⚠️  Failed to parse usage for ${stage}:`, error);
      return false;
    }
  }

  /**
   * Extract tokens from model responses
   */
  private extractTokensFromModelResponses(modelResponses: any[]): boolean {
    let extracted = false;
    logger.info(`🔍 Extracting tokens from ${modelResponses.length} model responses`);
    
    for (let i = 0; i < modelResponses.length; i++) {
      const response = modelResponses[i];
      
      // Check providerData.usage first (contains detailed usage with cached_tokens)
      // This is the most important source for cached_tokens
      if (response?.providerData?.usage) {
        const usage = response.providerData.usage;
        logger.info(`📊 Found providerData.usage in model_response[${i}]`, {
          prompt_tokens: usage.prompt_tokens,
          cached_tokens: usage.prompt_tokens_details?.cached_tokens || 0
        });
        if (this.recordTokenUsage(`model_response_${i}_provider`, usage)) {
          extracted = true;
          // Log if we found cached_tokens
          const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
          if (cachedTokens > 0) {
            logger.info(`✅ Found cached_tokens in model_response_${i}_provider: ${cachedTokens}`);
          }
        }
      }
      
      // Also check direct usage property (fallback)
      if (response?.usage) {
        logger.info(`📊 Found direct usage in model_response[${i}]`);
        if (this.recordTokenUsage(`model_response_${i}`, response.usage)) {
          extracted = true;
        }
      }
    }
    
    logger.info(`🔍 Extraction complete: ${extracted ? 'found' : 'not found'} tokens from modelResponses`);
    return extracted;
  }

  /**
   * Extract tokens from steps
   */
  private extractTokensFromSteps(steps: any[]): boolean {
    let extracted = false;
    for (let i = 0; i < steps.length; i++) {
      const stepAny = steps[i] as any;
      if (stepAny?.usage) {
        const stepType = stepAny.type || 'unknown';
        if (this.recordTokenUsage(`step_${stepType}_${i}`, stepAny.usage)) {
          extracted = true;
        }
      }
    }
    return extracted;
  }

  /**
   * Deep search for token usage in state object
   */
  private deepSearchTokenUsage(obj: any, path: string = ''): boolean {
    if (!obj || typeof obj !== 'object') return false;

    let found = false;

    // Check providerData.usage first (contains detailed usage with cached_tokens)
    if (obj.providerData?.usage && typeof obj.providerData.usage === 'object') {
      this.recordTokenUsage(`deep_search_${path}_provider`, obj.providerData.usage);
      found = true;
    }

    // Check if this object has usage-like properties
    if (obj.usage && typeof obj.usage === 'object') {
      this.recordTokenUsage(`deep_search_${path}`, obj.usage);
      found = true;
    }
    if (obj.prompt_tokens !== undefined || obj.completion_tokens !== undefined || obj.total_tokens !== undefined) {
      this.recordTokenUsage(`deep_search_${path}`, obj);
      found = true;
    }

    // Recursively search nested objects (continue searching even if we found something)
    for (const key in obj) {
      if (obj.hasOwnProperty(key) && typeof obj[key] === 'object' && obj[key] !== null) {
        const childFound = this.deepSearchTokenUsage(
          obj[key],
          path ? `${path}.${key}` : key
        );
        found = found || childFound;
      }
    }
    return found;
  }

  /**
   * Log token usage summary with tool breakdown
   */
  private logTokenUsageSummary(toolCalls: ToolCallInfo[]): void {
    const totalUsage = this.tokenTracker.getTotal();
    const report = this.tokenTracker.getReport();

    // Calculate total cached tokens across all stages
    const totalCachedTokens = report.stages.reduce(
      (sum, stage) => sum + (stage.tokens.cachedTokens || 0),
      0
    );

    // Log cached tokens benefit
    if (totalCachedTokens > 0) {
      logger.info(`📦 Performance: ${totalCachedTokens} tokens saved via prompt cache`, {
        cachedTokens: totalCachedTokens,
        totalPromptTokens: totalUsage.promptTokens,
        cacheHitRate: totalUsage.promptTokens > 0 
          ? `${((totalCachedTokens / totalUsage.promptTokens) * 100).toFixed(2)}%`
          : '0%',
      });
    }

    logger.info('💰 Token Usage Summary:', {
      total: {
        promptTokens: totalUsage.promptTokens,
        completionTokens: totalUsage.completionTokens,
        totalTokens: totalUsage.totalTokens,
        cachedTokens: totalCachedTokens,
      },
      stages: report.stages.map(s => ({
        stage: s.stage,
        promptTokens: s.tokens.promptTokens,
        completionTokens: s.tokens.completionTokens,
        totalTokens: s.tokens.totalTokens,
        cachedTokens: s.tokens.cachedTokens || 0,
      })),
      toolCallsCount: toolCalls.length,
      requestDuration: report.endTime && report.startTime 
        ? `${((report.endTime - report.startTime) / 1000).toFixed(2)}s`
        : 'N/A',
    });
  }

  /**
   * Extract answer from result and sanitize it
   */
  private extractAnswer(result: any): string {
    let answer = String(result.finalOutput || 'No answer generated');
    
    if (!result.finalOutput) {
      logger.warn('⚠️  Agent returned no final output');
    }

    // Sanitize answer to remove technical details
    answer = this.sanitizeAnswer(answer);

    return answer;
  }

  /**
   * Sanitize answer to remove technical database details
   */
  private sanitizeAnswer(answer: string): string {
    // List of technical terms to replace or remove
    const technicalPatterns = [
      // Table names (common patterns)
      /\bdevice_geofencings\b/gi,
      /\bdevice_current_data\b/gi,
      /\bincoming_message_history_k\b/gi,
      /\buser_device_assignment\b/gi,
      /\bfacilities\b/gi,
      /\bus_state_outlines\b/gi,
      // Column names (common patterns)
      /\blongitude\b/gi,
      /\blatitude\b/gi,
      /\bentry_event_time\b/gi,
      /\bexit_event_time\b/gi,
      /\bfacility_id\b/gi,
      /\bdevice_id\b/gi,
      // SQL/technical terms
      /\bST_Contains\b/gi,
      /\bST_GeomFromText\b/gi,
      /\bST_MakePoint\b/gi,
      /\bPOLYGON\b/gi,
      /\bSELECT\b/gi,
      /\bFROM\b/gi,
      /\bWHERE\b/gi,
      /\bJOIN\b/gi,
      // Error patterns that expose technical details
      /column\s+[\w_]+\s+does\s+not\s+exist/gi,
      /relation\s+["']?[\w_]+["']?\s+does\s+not\s+exist/gi,
      /table\s+["']?[\w_]+["']?\s+does\s+not\s+exist/gi,
      /available\s+in\s+the\s+[\w_]+\s+table/gi,
      /not\s+available\s+in\s+the\s+[\w_]+\s+table/gi,
      /using\s+the\s+available\s+columns/gi,
    ];

    let sanitized = answer;

    // Check if answer contains valid JSON (journey results, CSV links, etc.) - don't sanitize these
    const hasValidJson = answer.includes('"journies"') || 
                        answer.includes('"facilities_details"') ||
                        answer.includes('CSV Download Link') ||
                        answer.includes('csv_id') ||
                        answer.includes('download-csv');
    
    // Check if answer contains technical details (but not valid JSON results)
    const hasTechnicalDetails = !hasValidJson && technicalPatterns.some(pattern => pattern.test(answer));

    if (hasTechnicalDetails) {
      logger.warn('⚠️  Answer contains technical details, sanitizing...');
      
      // Replace technical error messages with user-friendly ones
      sanitized = answer
        // Remove references to specific tables and columns
        .replace(/because\s+the\s+[\w\s]+(?:table|column|information)\s+is\s+not\s+available[^.]*/gi, 
          'because the requested information is not available')
        .replace(/longitude\s+information\s+is\s+not\s+available[^.]*/gi, 
          'location information is not available')
        .replace(/in\s+the\s+[\w_]+\s+table[^.]*/gi, 'in the system')
        .replace(/using\s+the\s+available\s+columns[^.]*/gi, 'with the available data')
        .replace(/column\s+[\w_]+\s+does\s+not\s+exist[^.]*/gi, 
          'the requested information is not available')
        .replace(/relation\s+["']?[\w_]+["']?\s+does\s+not\s+exist[^.]*/gi, 
          'the requested information is not available')
        // Remove technical explanations
        .replace(/Unfortunately,\s+this\s+means\s+I\s+can't\s+directly\s+perform\s+a\s+[\w\s]+filter[^.]*/gi, 
          'Unfortunately, I cannot process this request with the available data')
        .replace(/If\s+you\s+have\s+any\s+other\s+questions[^.]*/gi, 
          'If you have any other questions, please let me know!');

      // If the sanitized answer still looks too technical, provide a generic message
      const stillHasTechnicalDetails = technicalPatterns.some(pattern => pattern.test(sanitized));
      if (stillHasTechnicalDetails) {
        logger.warn('⚠️  Answer still contains technical details after sanitization, using generic message');
        sanitized = "I'm unable to retrieve that information at the moment. Please try rephrasing your question or contact support if the issue persists.";
      }
    } else if (hasValidJson) {
      // Answer contains valid JSON results - keep it as is
      logger.debug('✅ Answer contains valid JSON results, keeping original');
      sanitized = answer;
    }

    return sanitized;
  }

  /**
   * Extract SQL query and results from tool calls and answer
   */
  private async extractQueryInfo(
    toolCalls: ToolCallInfo[],
    answer: string
  ): Promise<{
    sqlQuery?: string;
    queryResult?: string;
    csvId?: string;
    csvDownloadPath?: string;
  }> {
    let sqlQuery: string | undefined;
    let queryResult: string | undefined;
    let csvId: string | undefined;
    let csvDownloadPath: string | undefined;

    // Extract from tool calls
    for (const toolCall of toolCalls) {
      // Handle regular SQL tools
      if (
        (toolCall.tool === 'execute_db_query' ||
          toolCall.tool === 'count_query' ||
          toolCall.tool === 'list_query') &&
        toolCall.input?.query
      ) {
        sqlQuery = toolCall.input.query;
        queryResult =
          typeof toolCall.output === 'string'
            ? toolCall.output
            : JSON.stringify(toolCall.output);
        break;
      }
      // Handle journey tools (they use 'sql' parameter)
      if (
        (toolCall.tool === 'journey_list_tool' || toolCall.tool === 'journey_count_tool') &&
        toolCall.input?.sql
      ) {
        sqlQuery = toolCall.input.sql;
        queryResult =
          typeof toolCall.output === 'string'
            ? toolCall.output
            : JSON.stringify(toolCall.output);
        // Don't break - continue to check for other tools, but journey tools take priority for SQL
        if (!sqlQuery) {
          sqlQuery = toolCall.input.sql;
        }
      }
    }

    // Fallback: Extract from answer text
    if (!sqlQuery) {
      sqlQuery = this.extractSqlFromAnswer(answer);
    }

    // Extract CSV info from answer
    if (answer.includes('CSV Download Link:')) {
      const csvMatch = answer.match(/CSV ID: ([^\s]+)/);
      if (csvMatch) {
        csvId = csvMatch[1];
        csvDownloadPath = `/download-csv/${csvId}`;
      }
    }

    return { sqlQuery, queryResult, csvId, csvDownloadPath };
  }

  /**
   * Extract SQL query from answer text using patterns
   */
  private extractSqlFromAnswer(answer: string): string | undefined {
    const sqlPatterns = [
      /SQL:\s*([^\n]+)/i,
      /```sql\s*([\s\S]*?)```/i,
      /```\s*([\s\S]*?)```/i,
      /SELECT[\s\S]*?;/i,
    ];

    for (const pattern of sqlPatterns) {
      const match = answer.match(pattern);
      if (match) {
        const sql = match[1]?.trim() || match[0]?.trim();
        if (sql) {
          logger.info('📝 SQL query extracted from answer text:', {
            pattern: pattern.toString(),
            sql: sql.substring(0, 200),
          });
          return sql;
        }
      }
    }
    return undefined;
  }

  /**
   * Extract tool errors from tool calls
   */
  private extractToolErrors(
    toolCalls: ToolCallInfo[]
  ): Array<{ tool: string; error: string; input?: any }> {
    return toolCalls
      .filter((tc) => tc.hasError)
      .map((tc) => ({
        tool: tc.tool,
        error:
          typeof tc.output === 'string'
            ? tc.output
            : tc.error?.message || String(tc.error || tc.output),
        input: tc.input,
      }));
  }

  /**
   * Log comprehensive summary
   */
  private logSummary(
    answer: string,
    sqlQuery: string | undefined,
    toolCalls: ToolCallInfo[],
    queryResult: string | undefined
  ): void {
    // Log tool calls with proper formatting
    if (toolCalls.length > 0) {
      logger.info(`📊 Tool Calls Summary (${toolCalls.length} tool(s)):`, {
        tools: toolCalls.map((tc) => ({
          name: tc.tool,
          hasError: tc.hasError,
          hasOutput: !!tc.output,
          inputPreview: tc.input?.query
            ? tc.input.query.substring(0, 100)
            : 'N/A',
        })),
        errors: toolCalls
          .filter((tc) => tc.hasError)
          .map((tc) => ({
            tool: tc.tool,
            error: tc.error?.message || String(tc.error || tc.output),
          })),
      });

      // Log each tool call individually
      for (const toolCall of toolCalls) {
        if (toolCall.hasError) {
          logger.error(`❌ Tool Error [${toolCall.tool}]:`, {
            tool: toolCall.tool,
            input: toolCall.input,
            error: toolCall.error?.message || String(toolCall.error || toolCall.output),
          });
        } else {
          logger.info(`✅ Tool Success [${toolCall.tool}]:`, {
            tool: toolCall.tool,
            inputPreview: toolCall.input?.query
              ? toolCall.input.query.substring(0, 100)
              : 'N/A',
            outputPreview:
              typeof toolCall.output === 'string'
                ? toolCall.output.substring(0, 200)
                : 'Non-string result',
          });
        }
      }
    } else {
      logger.warn('⚠️  No tool calls detected in agent result');
    }

    // Log SQL query status
    if (sqlQuery) {
      logger.info('✅ SQL Query Found:', {
        sql: sqlQuery,
        length: sqlQuery.length,
        hasResult: !!queryResult,
      });
    } else {
      logger.warn('⚠️  No SQL query extracted from tool calls or answer');
    }

    // Log final response
    logger.info('💬 Agent Response:', {
      answerLength: answer.length,
      answerPreview: answer.substring(0, 200),
      hasSqlQuery: !!sqlQuery,
      toolCallsCount: toolCalls.length,
    });
  }
}
