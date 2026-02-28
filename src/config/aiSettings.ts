import { sequelizeReadOnly } from './database';
import { QueryTypes } from 'sequelize';
import { logger } from '../utils/logger';

const DEFAULT_MODEL = 'gpt-4o';

/**
 * Get the chat model name from ai_settings (name='model_name').
 * Falls back to DEFAULT_MODEL if not found or on error.
 */
export async function getAiModelName(): Promise<string> {
  try {
    const rows = await sequelizeReadOnly.query<{ value: string }>(
      `SELECT value FROM ai_settings WHERE name = 'model_name' LIMIT 1`,
      { type: QueryTypes.SELECT },
    );

    const value = rows?.[0]?.value?.trim();
    if (value) {
      return value;
    }
  } catch (error) {
    logger.warn(`Failed to read ai_settings.model_name, using default: ${error}`);
  }

  return DEFAULT_MODEL;
}
