import winston from 'winston';
import path from 'path';
import fs from 'fs';
import { settings } from '../config/settings';

// Ensure log directory exists
const logDir = path.resolve(process.cwd(), settings.logDir);
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Custom format for structured logging
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(meta).length > 0) {
      msg += ` ${JSON.stringify(meta)}`;
    }
    return msg;
  })
);

// Create transports array
const transports: winston.transport[] = [];

// Console transport
if (settings.logToConsole) {
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: settings.logLevel.toLowerCase(),
    })
  );
}

// File transports
if (settings.logToFile) {
  // Main log file (all levels)
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'app.log'),
      format: logFormat,
      level: 'debug',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: settings.logRetentionDays,
    })
  );

  // Error log file (errors only)
  transports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      format: logFormat,
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: settings.logRetentionDays,
    })
  );
}

// Create logger instance (file + console per settings)
export const logger = winston.createLogger({
  level: settings.logLevel.toLowerCase(),
  format: logFormat,
  transports,
  exitOnError: false,
});

// File-only transports (no console) for logs that should not go to console
const fileOnlyTransports: winston.transport[] = [];
if (settings.logToFile) {
  fileOnlyTransports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'app.log'),
      format: logFormat,
      level: 'debug',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: settings.logRetentionDays,
    })
  );
  fileOnlyTransports.push(
    new winston.transports.File({
      filename: path.join(logDir, 'error.log'),
      format: logFormat,
      level: 'error',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: settings.logRetentionDays,
    })
  );
}

/** Logger that writes only to file (no console). Use for verbose/noisy logs (e.g. full RESULT). */
export const loggerFileOnly = winston.createLogger({
  level: settings.logLevel.toLowerCase(),
  format: logFormat,
  transports: fileOnlyTransports.length > 0 ? fileOnlyTransports : [new winston.transports.Console({ silent: true })],
  exitOnError: false,
});

export type RequestLogger = winston.Logger & {
  /** Log only to file (not console). Use for high-volume or sensitive entries. */
  fileOnly: winston.Logger;
};

// Helper function to create child logger with request context
export function createRequestLogger(requestId: string, userId?: string): RequestLogger {
  const child = logger.child({ requestId, userId });
  const fileOnlyChild = loggerFileOnly.child({ requestId, userId });
  return Object.assign(child, { fileOnly: fileOnlyChild }) as RequestLogger;
}

// Export default logger
export default logger;
