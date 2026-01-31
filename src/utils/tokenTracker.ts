/**
 * Token Usage Tracking Utility
 * 
 * Tracks token consumption per request and per stage for debugging and monitoring.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface StageTokenUsage {
  stage: string;
  tokens: TokenUsage;
  timestamp: number;
}

export interface RequestTokenUsage {
  requestId: string;
  userId?: string;
  stages: StageTokenUsage[];
  total: TokenUsage;
  startTime: number;
  endTime?: number;
}

export class TokenTracker {
  private requestId: string;
  private userId?: string;
  private stages: StageTokenUsage[] = [];
  private startTime: number;

  constructor(requestId: string, userId?: string) {
    this.requestId = requestId;
    this.userId = userId;
    this.startTime = Date.now();
  }

  /**
   * Record token usage for a specific stage
   */
  recordStage(stage: string, tokens: TokenUsage): void {
    this.stages.push({
      stage,
      tokens,
      timestamp: Date.now(),
    });
  }

  /**
   * Get total token usage across all stages
   */
  getTotal(): TokenUsage {
    const total = this.stages.reduce(
      (acc, stage) => ({
        promptTokens: acc.promptTokens + stage.tokens.promptTokens,
        completionTokens: acc.completionTokens + stage.tokens.completionTokens,
        totalTokens: acc.totalTokens + stage.tokens.totalTokens,
      }),
      { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    );

    return total;
  }

  /**
   * Get complete token usage report
   */
  getReport(): RequestTokenUsage {
    return {
      requestId: this.requestId,
      userId: this.userId,
      stages: this.stages,
      total: this.getTotal(),
      startTime: this.startTime,
      endTime: Date.now(),
    };
  }

  /**
   * Convert OpenAI usage response to TokenUsage
   */
  static fromOpenAIUsage(usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  }): TokenUsage {
    return {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    };
  }

  /**
   * Convert usage from OpenAI Agents SDK response
   */
  static fromAgentsUsage(usage: any): TokenUsage {
    // OpenAI Agents SDK may have different structure
    if (usage && typeof usage === 'object') {
      return {
        promptTokens: usage.promptTokens || usage.prompt_tokens || 0,
        completionTokens: usage.completionTokens || usage.completion_tokens || 0,
        totalTokens: usage.totalTokens || usage.total_tokens || 0,
      };
    }
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
}
