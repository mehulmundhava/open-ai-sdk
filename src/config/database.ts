import { Sequelize, Options } from 'sequelize';
import { settings } from './settings';

// Global query timeout in seconds (60 seconds)
export const QUERY_TIMEOUT_SECONDS = 60;

/**
 * Create a Sequelize instance with proper configuration
 */
function createSequelizeInstance(
  user: string,
  password: string,
  connectionName: string
): Sequelize {
  const config: Options = {
    host: settings.dbHost,
    port: settings.dbPort,
    database: settings.dbName,
    username: user,
    password: password,
    dialect: 'postgres',
    logging: false, // Set to console.log for SQL logging
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    dialectOptions: {
      ssl: settings.dbSslMode !== 'disable' ? {
        require: true,
        rejectUnauthorized: false,
      } : false,
    },
  };

  const sequelize = new Sequelize(config);

  // Set query timeout on connection
  sequelize.addHook('afterConnect', async (connection: any) => {
    try {
      await connection.query(`SET statement_timeout = ${QUERY_TIMEOUT_SECONDS * 1000}`);
      console.log(`✅ ${connectionName}: Set statement_timeout to ${QUERY_TIMEOUT_SECONDS} seconds`);
    } catch (error) {
      console.warn(`⚠️  Failed to set statement_timeout on ${connectionName}: ${error}`);
    }
  });

  console.log(`✅ ${connectionName} Sequelize instance created`);
  console.log(`   Host: ${settings.dbHost}:${settings.dbPort}`);
  console.log(`   Database: ${settings.dbName}`);
  console.log(`   User: ${user}`);
  console.log(`   Query Timeout: ${QUERY_TIMEOUT_SECONDS} seconds`);

  return sequelize;
}

// Read-only connection (for health, chat endpoints)
export const sequelizeReadOnly = createSequelizeInstance(
  settings.dbUser,
  settings.dbPassword,
  'Read-Only Database'
);

// Update connection (for embedding generation routes)
export const sequelizeUpdate = settings.updateUser && settings.updatePassword
  ? createSequelizeInstance(
      settings.updateUser,
      settings.updatePassword,
      'Update Database'
    )
  : sequelizeReadOnly;

if (settings.updateUser && settings.updatePassword) {
  console.log('✅ Using separate UPDATE_USER connection for embedding routes');
} else {
  console.log('⚠️  UPDATE_USER not configured - using readonly connection for embedding routes (not recommended)');
}

// Test connections
export async function testConnections(): Promise<void> {
  try {
    await sequelizeReadOnly.authenticate();
    console.log('✅ Read-only database connection established');
  } catch (error) {
    console.error('❌ Read-only database connection failed:', error);
    throw error;
  }

  if (sequelizeUpdate !== sequelizeReadOnly) {
    try {
      await sequelizeUpdate.authenticate();
      console.log('✅ Update database connection established');
    } catch (error) {
      console.error('❌ Update database connection failed:', error);
      throw error;
    }
  }
}
