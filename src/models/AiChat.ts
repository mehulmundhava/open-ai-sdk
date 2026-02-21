import { Model, DataTypes, Sequelize, Optional } from 'sequelize';

export interface AiChatAttributes {
  id: string; // UUID
  user_id: number; // BIGINT
  previous_response_id: string | null;
  created_at: Date;
  last_message_at: Date | null;
}

export interface AiChatCreationAttributes
  extends Optional<AiChatAttributes, 'id' | 'created_at' | 'last_message_at' | 'previous_response_id'> {}

export class AiChat extends Model<AiChatAttributes, AiChatCreationAttributes>
  implements AiChatAttributes {
  public id!: string;
  public user_id!: number;
  public previous_response_id!: string | null;
  public created_at!: Date;
  public last_message_at!: Date | null;
  public static initModel(sequelize: Sequelize): typeof AiChat {
    return AiChat.init(
      {
        id: {
          type: DataTypes.UUID,
          primaryKey: true,
          defaultValue: DataTypes.UUIDV4,
        },
        user_id: {
          type: DataTypes.BIGINT,
          allowNull: false,
        },
        previous_response_id: {
          type: DataTypes.UUID,
          allowNull: true,
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
      },
      {
        sequelize,
        tableName: 'ai_chat',
        timestamps: false, // We use created_at manually
        underscored: true,
      }
    ) as typeof AiChat;
  }
}
