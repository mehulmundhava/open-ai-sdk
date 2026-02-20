import { sequelizeReadOnly, sequelizeUpdate } from '../config/database';
import { VectorExample } from './VectorExample';
import { VectorExtraPrompt } from './VectorExtraPrompt';
import { AiChat } from './AiChat';
import { AiChatMessage } from './AiChatMessage';

// Initialize models with read-only connection
VectorExample.initModel(sequelizeReadOnly);
VectorExtraPrompt.initModel(sequelizeReadOnly);

// Initialize models with update connection (for write operations)
AiChat.initModel(sequelizeUpdate);
AiChatMessage.initModel(sequelizeUpdate);

// Export models and connections
export {
  sequelizeReadOnly,
  sequelizeUpdate,
  VectorExample,
  VectorExtraPrompt,
  AiChat,
  AiChatMessage,
};
