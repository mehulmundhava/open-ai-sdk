import { Request, Response } from 'express';
import { AiChat } from '../models';
import { logger } from '../utils/logger';

/**
 * Create a new chat entry
 */
export async function createChatEntry(req: Request, res: Response): Promise<void> {
  try {
    const { user_id } = req.body;

    // Validate user_id
    if (!user_id) {
      res.status(400).json({
        error: 'Missing required field: user_id',
      });
      return;
    }

    // Validate user_id is a number
    const userId = Number(user_id);
    if (isNaN(userId) || userId <= 0) {
      res.status(400).json({
        error: 'user_id must be a positive number',
      });
      return;
    }

    // Create chat entry
    const chatEntry = await AiChat.create({
      user_id: userId,
    });

    logger.info('✅ Chat entry created', {
      id: chatEntry.id,
      user_id: chatEntry.user_id,
      created_at: chatEntry.created_at,
    });

    // Return the created chat entry ID
    res.status(201).json({
      success: true,
      id: chatEntry.id,
      user_id: chatEntry.user_id,
      created_at: chatEntry.created_at,
    });
  } catch (error: any) {
    logger.error('❌ Error creating chat entry:', {
      error: error?.message,
      stack: error?.stack,
      body: req.body,
    });

    res.status(500).json({
      error: 'Failed to create chat entry',
      message: error?.message || 'Unknown error',
    });
  }
}
