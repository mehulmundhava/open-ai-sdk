import { Model, DataTypes, Sequelize, Optional } from 'sequelize';

export interface AiChatAttributes {
  id: string;
  user_id: number;
  created_at: Date;
  last_message_at: Date | null;
  conversation_id: string | null;
}

export interface AiChatCreationAttributes
  extends Optional<AiChatAttributes, 'id' | 'created_at' | 'last_message_at' | 'conversation_id'> {}

export class AiChat extends Model<AiChatAttributes, AiChatCreationAttributes> implements AiChatAttributes {
  public id!: string;
  public user_id!: number;
  public created_at!: Date;
  public last_message_at!: Date | null;
  public conversation_id!: string | null;

  public static initModel(sequelize: Sequelize): typeof AiChat {
    return AiChat.init(
      {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
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
        last_message_at: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        conversation_id: {
          type: DataTypes.STRING,
          allowNull: true,
        },
      },
      {
        sequelize,
        tableName: 'ai_chat',
        timestamps: false,
        underscored: true,
      }
    ) as typeof AiChat;
  }
}
