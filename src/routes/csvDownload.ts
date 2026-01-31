import { Router, Request, Response } from 'express';
import { getCSVById } from '../utils/csvGenerator';
import { logger } from '../utils/logger';
import * as fs from 'fs';

const router = Router();

// UUID v4 pattern (8-4-4-4-12 hex). Mounted at /download-csv so full path is GET /download-csv/:csvId
const UUID_REGEX = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i;

router.get('/:csvId', async (req: Request, res: Response): Promise<void> => {
  try {
    let { csvId } = req.params;

    logger.info(`CSV download requested for ID: ${csvId}`);

    if (!csvId) {
      res.status(400).json({
        error: 'Missing CSV ID',
      });
      return;
    }

    // Sanitize: strip trailing non-UUID chars (e.g. ")" from markdown link [text](url))
    const match = csvId.match(UUID_REGEX);
    if (match) {
      csvId = match[1];
    }

    const csvFilePath = getCSVById(csvId);

    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
      logger.warn(`CSV not found for ID: ${csvId}`);
      res.status(404).json({
        error: `CSV file with ID '${csvId}' not found. It may have expired or been deleted.`,
      });
      return;
    }

    // Set headers for CSV download (match Python: query_results_{csv_id}.csv, text/csv; charset=utf-8)
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=query_results_${csvId}.csv`);

    const fileSize = fs.statSync(csvFilePath).size;
    logger.info(`CSV retrieved successfully for ID: ${csvId}, size: ${fileSize} bytes`);

    logger.info('📤 CSV Download API Response:', {
      method: req.method,
      path: req.path,
      statusCode: 200,
      csvId: csvId,
      filePath: csvFilePath,
    });

    // Stream the file
    const fileStream = fs.createReadStream(csvFilePath);
    fileStream.pipe(res);

    fileStream.on('error', (error) => {
      logger.error(`Error streaming CSV file: ${error}`);
      logger.error('📤 CSV Download API Error Response:', {
        method: req.method,
        path: req.path,
        statusCode: 500,
        error: 'Error reading CSV file',
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Error reading CSV file',
        });
      }
    });
  } catch (error: any) {
    logger.error(`CSV download route error: ${error}`);
    const errorResponse = {
      error: error.message || 'Internal server error',
    };
    logger.error('📤 CSV Download API Error Response:', {
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: errorResponse,
    });
    if (!res.headersSent) {
      res.status(500).json(errorResponse);
    }
  }
});

export default router;
