import { Model, DataTypes, Sequelize, Optional } from 'sequelize';

export interface VectorExampleAttributes {
  id: number;
  question: string;
  sql_query: string;
  description?: string | null;
  metadata?: Record<string, any> | null;
  minilm_embedding?: number[] | null;
  bge_large_embedding?: number[] | null;
  entry_type?: string | null;
  answer?: string | null;
  question_type?: string | null;
  user_type?: string | null;
  similarity_threshold?: number | null;
  usage_count?: number | null;
  last_used?: Date | null;
  is_active?: boolean | null;
  is_deterministic?: boolean | null;
  created_at?: Date | null;
}

export interface VectorExampleCreationAttributes
  extends Optional<VectorExampleAttributes, 'id' | 'description' | 'metadata' 
    | 'minilm_embedding' | 'bge_large_embedding' | 'entry_type' | 'answer' 
    | 'question_type' | 'user_type' | 'similarity_threshold' | 'usage_count' 
    | 'last_used' | 'is_active' | 'is_deterministic' | 'created_at'> {}

export class VectorExample extends Model<VectorExampleAttributes, VectorExampleCreationAttributes>
  implements VectorExampleAttributes {
  public id!: number;
  public question!: string;
  public sql_query!: string;
  public description?: string | null;
  public metadata?: Record<string, any> | null;
  public minilm_embedding?: number[] | null;
  public bge_large_embedding?: number[] | null;
  public entry_type?: string | null;
  public answer?: string | null;
  public question_type?: string | null;
  public user_type?: string | null;
  public similarity_threshold?: number | null;
  public usage_count?: number | null;
  public last_used?: Date | null;
  public is_active?: boolean | null;
  public is_deterministic?: boolean | null;
  public created_at?: Date | null;

  public static initModel(sequelize: Sequelize): typeof VectorExample {
    return VectorExample.init(
      {
        id: {
          type: DataTypes.BIGINT,
          autoIncrement: true,
          primaryKey: true,
        },
        question: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        sql_query: {
          type: DataTypes.TEXT,
          allowNull: false,
        },
        description: {
          type: DataTypes.TEXT,
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
        entry_type: {
          type: DataTypes.STRING(20),
          allowNull: true,
          defaultValue: 'example',
        },
        answer: {
          type: DataTypes.TEXT,
          allowNull: true,
        },
        question_type: {
          type: DataTypes.STRING(20),
          allowNull: true,
        },
        user_type: {
          type: DataTypes.STRING(20),
          allowNull: true,
        },
        similarity_threshold: {
          type: DataTypes.FLOAT,
          allowNull: true,
          defaultValue: 0.80,
        },
        usage_count: {
          type: DataTypes.INTEGER,
          allowNull: true,
          defaultValue: 0,
        },
        last_used: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        is_active: {
          type: DataTypes.BOOLEAN,
          allowNull: true,
          defaultValue: true,
        },
        is_deterministic: {
          type: DataTypes.BOOLEAN,
          allowNull: true,
          defaultValue: false,
        },
        created_at: {
          type: DataTypes.DATE,
          allowNull: true,
          defaultValue: DataTypes.NOW,
        },
      },
      {
        sequelize,
        tableName: 'ai_vector_examples',
        timestamps: false, // We use created_at manually
        underscored: true,
      }
    ) as typeof VectorExample;
  }
}
