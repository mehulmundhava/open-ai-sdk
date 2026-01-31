import { Router, Request, Response } from 'express';
import { getCSVById } from '../utils/csvGenerator';
import { logger } from '../utils/logger';
import * as fs from 'fs';

const router = Router();

router.get('/download-csv/:csvId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { csvId } = req.params;

    if (!csvId) {
      res.status(400).json({
        error: 'Missing CSV ID',
      });
      return;
    }

    const csvFilePath = getCSVById(csvId);

    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
      res.status(404).json({
        error: 'CSV file not found',
      });
      return;
    }

    // Set headers for CSV download
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${csvId}.csv"`);

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
