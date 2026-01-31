import { Model, DataTypes, Sequelize, Optional } from 'sequelize';

export interface VectorExtraPromptAttributes {
  id: number;
  content: string;
  note_type?: string | null;
  metadata?: Record<string, any> | null;
  minilm_embedding?: number[] | null;
  bge_large_embedding?: number[] | null;
  created_at?: Date | null;
}

export interface VectorExtraPromptCreationAttributes
  extends Optional<VectorExtraPromptAttributes, 'id' | 'note_type' | 'metadata' 
    | 'minilm_embedding' | 'bge_large_embedding' | 'created_at'> {}

export class VectorExtraPrompt extends Model<VectorExtraPromptAttributes, VectorExtraPromptCreationAttributes>
  implements VectorExtraPromptAttributes {
  public id!: number;
  public content!: string;
  public note_type?: string | null;
  public metadata?: Record<string, any> | null;
  public minilm_embedding?: number[] | null;
  public bge_large_embedding?: number[] | null;
  public created_at?: Date | null;

  public static initModel(sequelize: Sequelize): typeof VectorExtraPrompt {
    return VectorExtraPrompt.init(
      {
        id: {
          type: DataTypes.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        content: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        note_type: {
          type: DataTypes.STRING,
          allowNull: true,
        },
        metadata: {
          type: DataTypes.JSONB,
          allowNull: true,
          defaultValue: {},
        },
        minilm_embedding: {
          type: DataTypes.ARRAY(DataTypes.FLOAT),
          allowNull: true,
        },
        bge_large_embedding: {
          type: DataTypes.ARRAY(DataTypes.FLOAT),
          allowNull: true,
        },
        created_at: {
          type: DataTypes.DATE,
          allowNull: true,
          defaultValue: DataTypes.NOW,
        },
      },
      {
        sequelize,
        tableName: 'ai_vector_extra_prompts',
        timestamps: false, // We use created_at manually
        underscored: true,
      }
    ) as typeof VectorExtraPrompt;
  }
}
