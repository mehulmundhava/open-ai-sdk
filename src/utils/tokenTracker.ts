/**
 * Token Usage Tracking Utility
 * 
 * Tracks token consumption per request and per stage for debugging and monitoring.
 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number; // Tokens saved via prompt caching
  promptTokensDetails?: {
    cached_tokens?: number;
    audio_tokens?: number;
  };
  completionTokensDetails?: {
    reasoning_tokens?: number;
    rejected_prediction_tokens?: number;
    accepted_prediction_tokens?: number;
    audio_tokens?: number;
  };
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
      (acc: TokenUsage, stage) => {
        // Get cached tokens from each stage (prefer promptTokensDetails.cached_tokens, fallback to cachedTokens)
        // Both contain the same value (set in fromAgentsUsage), but we prefer the details structure
        const stageCachedTokens = stage.tokens.promptTokensDetails?.cached_tokens ?? stage.tokens.cachedTokens ?? 0;
        const accCachedTokens = acc.promptTokensDetails?.cached_tokens ?? acc.cachedTokens ?? 0;
        const totalCachedTokens = accCachedTokens + stageCachedTokens;
        
        // Merge promptTokensDetails by summing cached_tokens and audio_tokens
        const mergedPromptDetails = {
          cached_tokens: totalCachedTokens,
          audio_tokens: (acc.promptTokensDetails?.audio_tokens || 0) + 
                       (stage.tokens.promptTokensDetails?.audio_tokens || 0),
        };
        
        // Merge completionTokensDetails by summing all fields
        const mergedCompletionDetails = {
          reasoning_tokens: (acc.completionTokensDetails?.reasoning_tokens || 0) + 
                           (stage.tokens.completionTokensDetails?.reasoning_tokens || 0),
          rejected_prediction_tokens: (acc.completionTokensDetails?.rejected_prediction_tokens || 0) + 
                                     (stage.tokens.completionTokensDetails?.rejected_prediction_tokens || 0),
          accepted_prediction_tokens: (acc.completionTokensDetails?.accepted_prediction_tokens || 0) + 
                                    (stage.tokens.completionTokensDetails?.accepted_prediction_tokens || 0),
          audio_tokens: (acc.completionTokensDetails?.audio_tokens || 0) + 
                       (stage.tokens.completionTokensDetails?.audio_tokens || 0),
        };
        
        return {
          promptTokens: acc.promptTokens + stage.tokens.promptTokens,
          completionTokens: acc.completionTokens + stage.tokens.completionTokens,
          totalTokens: acc.totalTokens + stage.tokens.totalTokens,
          cachedTokens: totalCachedTokens,
          promptTokensDetails: mergedPromptDetails.cached_tokens > 0 || mergedPromptDetails.audio_tokens > 0 
            ? mergedPromptDetails 
            : undefined,
          completionTokensDetails: mergedCompletionDetails.reasoning_tokens > 0 || 
                                  mergedCompletionDetails.rejected_prediction_tokens > 0 ||
                                  mergedCompletionDetails.accepted_prediction_tokens > 0 ||
                                  mergedCompletionDetails.audio_tokens > 0
            ? mergedCompletionDetails 
            : undefined,
        };
      },
      { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 } as TokenUsage
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
      const cachedTokens = 
        usage.prompt_tokens_details?.cached_tokens || 
        usage.promptTokensDetails?.cached_tokens || 
        usage.cached_tokens || 
        0;

      return {
        promptTokens: usage.promptTokens || usage.prompt_tokens || 0,
        completionTokens: usage.completionTokens || usage.completion_tokens || 0,
        totalTokens: usage.totalTokens || usage.total_tokens || 0,
        cachedTokens: cachedTokens,
        promptTokensDetails: usage.prompt_tokens_details || usage.promptTokensDetails,
        completionTokensDetails: usage.completion_tokens_details || usage.completionTokensDetails,
      };
    }
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 };
  }
}
