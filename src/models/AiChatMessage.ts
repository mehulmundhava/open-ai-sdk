import { Model, DataTypes, Sequelize, Optional } from 'sequelize';

export interface AiChatMessageAttributes {
  id: string; // UUID
  chat_id: string; // UUID
  user_id: number; // BIGINT
  created_at: Date;
  user_message: string | null;
  response_message: string | null;
  response: Record<string, any> | null;
  token_consumption: Record<string, any> | null;
  history: Record<string, any[]> | null;
}

export interface AiChatMessageCreationAttributes
  extends Optional<AiChatMessageAttributes, 'id' | 'created_at' | 'user_message' | 'response_message' | 'response' | 'token_consumption' | 'history'> {}

export class AiChatMessage extends Model<AiChatMessageAttributes, AiChatMessageCreationAttributes>
  implements AiChatMessageAttributes {
  public id!: string;
  public chat_id!: string;
  public user_id!: number;
  public created_at!: Date;
  public user_message!: string | null;
  public response_message!: string | null;
  public response!: Record<string, any> | null;
  public token_consumption!: Record<string, any> | null;
  public history!: Record<string, any> | null;

  public static initModel(sequelize: Sequelize): typeof AiChatMessage {
    return AiChatMessage.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        chat_id: {
          type: DataTypes.UUID,
          allowNull: false,
        },
        user_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
        },
        created_at: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        user_message: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        response_message: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        response: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        token_consumption: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
        history: {
          type: DataTypes.JSONB,
          allowNull: true,
        },
      },
      {
        sequelize,
        tableName: 'ai_chat_messages',
        timestamps: false, // We use created_at manually
        underscored: true,
      }
    ) as typeof AiChatMessage;
  }
}
