import { sequelizeReadOnly, sequelizeUpdate } from '../config/database';
import { VectorExample } from './VectorExample';
import { VectorExtraPrompt } from './VectorExtraPrompt';

// Initialize models with read-only connection
VectorExample.initModel(sequelizeReadOnly);
VectorExtraPrompt.initModel(sequelizeReadOnly);

// Export models and connections
export {
  sequelizeReadOnly,
  sequelizeUpdate,
  VectorExample,
  VectorExtraPrompt,
};
