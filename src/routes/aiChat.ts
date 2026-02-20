import { Router } from 'express';
import { createChatEntry } from '../controllers/aiChatController';

const router = Router();

/**
 * POST /ai-chat
 * Create a new chat entry
 * 
 * Request body:
 * {
 *   "user_id": 123
 * }
 * 
 * Response:
 * {
 *   "success": true,
 *   "id": "uuid-string",
 *   "user_id": 123,
 *   "created_at": "2024-01-01T00:00:00.000Z"
 * }
 */
router.post('/', createChatEntry);

export default router;
