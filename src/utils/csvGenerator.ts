import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import { v4 as uuidv4 } from 'uuid';
import { settings } from '../config/settings';
import { logger } from './logger';

// In-memory storage for CSV files (in production, use proper file storage or S3)
const csvStorage: Map<string, string> = new Map();

// CSV files directory
const csvDir = path.resolve(process.cwd(), 'csv_files');
if (!fs.existsSync(csvDir)) {
  fs.mkdirSync(csvDir, { recursive: true });
}

export interface CSVInfo {
  csv_id: string;
  row_count: number;
  preview_rows: Record<string, any>[];
  csv_link: string;
  csv_download_path: string;
  headers: string[];
}

/**
 * Generate CSV from query result text and return metadata.
 */
export function generateCSVFromResult(
  resultText: string,
  maxRows: number = 5
): CSVInfo | null {
  try {
    // Parse the result text (SQLDatabase returns formatted string)
    // Format is typically: "column1 | column2 | ...\nvalue1 | value2 | ..."
    const lines = resultText.trim().split('\n');
    if (lines.length < 2) {
      logger.warn('Result text has insufficient lines for CSV generation');
      return null;
    }

    // First line is header
    const headers = lines[0].split('|').map((col) => col.trim());
    if (headers.length === 0) {
      logger.warn('No headers found in result text');
      return null;
    }

    // Parse data rows
    const rows: Record<string, any>[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = line.split('|').map((val) => val.trim());
      if (values.length === headers.length) {
        const row: Record<string, any> = {};
        headers.forEach((header, index) => {
          row[header] = values[index];
        });
        rows.push(row);
      }
    }

    if (rows.length === 0) {
      logger.warn('No data rows found in result text');
      return null;
    }

    const totalRows = rows.length;

    // Generate unique ID
    const csvId = uuidv4();

    // Save CSV to file
    const csvFilePath = path.join(csvDir, `${csvId}.csv`);
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: headers.map((h) => ({ id: h, title: h })),
    });

    csvWriter.writeRecords(rows).catch((error) => {
      logger.error(`Error writing CSV file: ${error}`);
    });

    // Get preview rows (first maxRows)
    const previewRows = rows.slice(0, maxRows);

    // Generate download paths
    const csvLink = `/download-csv/${csvId}`;
    const csvDownloadPath = csvLink;

    logger.info(`Generated CSV: ${totalRows} rows, ID: ${csvId}`);

    return {
      csv_id: csvId,
      row_count: totalRows,
      preview_rows: previewRows,
      csv_link: csvLink,
      csv_download_path: csvDownloadPath,
      headers,
    };
  } catch (error) {
    logger.error(`Error generating CSV: ${error}`);
    return null;
  }
}

/**
 * Retrieve CSV file by ID.
 */
export function getCSVById(csvId: string): string | null {
  try {
    const csvFilePath = path.join(csvDir, `${csvId}.csv`);
    if (fs.existsSync(csvFilePath)) {
      return csvFilePath;
    }
    return null;
  } catch (error) {
    logger.error(`Error retrieving CSV: ${error}`);
    return null;
  }
}

/**
 * Format query result with CSV generation for large results.
 */
export function formatResultWithCSV(
  resultText: string,
  maxPreviewRows: number = 3
): string {
  try {
    // Parse result to count rows
    const lines = resultText.trim().split('\n');
    if (lines.length < 2) {
      return resultText; // Return as-is if no data
    }

    // Count data rows (excluding header)
    const dataRows = lines.slice(1).filter((line) => line.trim());
    const rowCount = dataRows.length;

    // If <= maxPreviewRows, return full result
    if (rowCount <= maxPreviewRows) {
      return resultText;
    }

    // Generate CSV for large results
    const csvInfo = generateCSVFromResult(resultText, maxPreviewRows);

    if (!csvInfo) {
      // Fallback: return preview only
      const previewLines = lines.slice(0, maxPreviewRows + 1); // Header + preview rows
      const previewText = previewLines.join('\n');
      return `Total rows: ${rowCount}\n\nFirst ${maxPreviewRows} rows:\n${previewText}\n\n(Full results available via CSV download)`;
    }

    // Format response with count, preview, and CSV link
    const previewLines = lines.slice(0, maxPreviewRows + 1);
    const previewText = previewLines.join('\n');

    const formattedResult = `Total rows: ${csvInfo.row_count}

First ${maxPreviewRows} rows:
${previewText}

CSV Download Link: ${csvInfo.csv_link}
CSV ID: ${csvInfo.csv_id}`;

    return formattedResult;
  } catch (error) {
    logger.error(`Error formatting result with CSV: ${error}`);
    // Fallback: return original result
    return resultText;
  }
}

/**
 * Generate CSV from journey list result.
 */
export function generateCSVFromJourneyList(
  journeyResult: {
    journies?: Array<Record<string, any>>;
    facilities_details?: Record<string, any>;
  },
  maxPreview: number = 5
): CSVInfo | null {
  try {
    const journies = journeyResult.journies || [];
    const facilitiesDetails = journeyResult.facilities_details || {};

    if (journies.length === 0) {
      return null;
    }

    const totalJourneys = journies.length;

    // If <= maxPreview, return null (no CSV needed)
    if (totalJourneys <= maxPreview) {
      return null;
    }

    // Prepare CSV headers
    const headers = [
      'from_facility',
      'to_facility',
      'device_id',
      'journey_time_seconds',
      'entry_time',
      'exit_time',
      'from_facility_type',
      'to_facility_type',
      'from_facility_name',
      'to_facility_name',
    ];

    // Convert journeys to CSV rows
    const csvRows: Record<string, any>[] = [];
    for (const journey of journies) {
      const fromFac = journey.from_facility || '';
      const toFac = journey.to_facility || '';

      // Get facility details
      const fromFacDetails = facilitiesDetails[fromFac] || {};
      const toFacDetails = facilitiesDetails[toFac] || {};

      const row = {
        from_facility: fromFac,
        to_facility: toFac,
        device_id: journey.device_id || '',
        journey_time_seconds: journey.journey_time || '',
        entry_time: journey.entry_time || '',
        exit_time: journey.exit_time || '',
        from_facility_type: fromFacDetails.facility_type || '',
        to_facility_type: toFacDetails.facility_type || '',
        from_facility_name: fromFacDetails.facility_name || '',
        to_facility_name: toFacDetails.facility_name || '',
      };
      csvRows.push(row);
    }

    // Generate unique ID
    const csvId = uuidv4();

    // Save CSV to file
    const csvFilePath = path.join(csvDir, `${csvId}.csv`);
    const csvWriter = createObjectCsvWriter({
      path: csvFilePath,
      header: headers.map((h) => ({ id: h, title: h })),
    });

    csvWriter.writeRecords(csvRows).catch((error) => {
      logger.error(`Error writing journey CSV file: ${error}`);
    });

    // Get preview journeys (first maxPreview)
    const previewJournies = journies.slice(0, maxPreview);

    // Generate download paths
    const csvLink = `/download-csv/${csvId}`;
    const csvDownloadPath = csvLink;

    logger.info(`Generated journey CSV: ${totalJourneys} journeys, ID: ${csvId}`);

    return {
      csv_id: csvId,
      row_count: totalJourneys,
      preview_rows: previewJournies,
      csv_link: csvLink,
      csv_download_path: csvDownloadPath,
      headers,
    };
  } catch (error) {
    logger.error(`Error generating journey CSV: ${error}`);
    return null;
  }
}

/**
 * Format journey list result with CSV generation for large results.
 */
export function formatJourneyListWithCSV(
  journeyResult: {
    journies?: Array<Record<string, any>>;
    facilities_details?: Record<string, any>;
  },
  maxPreview: number = 5
): string {
  try {
    const journies = journeyResult.journies || [];
    const totalJourneys = journies.length;

    // If <= maxPreview, return full result
    if (totalJourneys <= maxPreview) {
      return JSON.stringify(journeyResult, null, 2);
    }

    // Generate CSV for large results
    const csvInfo = generateCSVFromJourneyList(journeyResult, maxPreview);

    if (!csvInfo) {
      // Fallback: return full result
      return JSON.stringify(journeyResult, null, 2);
    }

    // Create result with preview and CSV link
    const previewResult = {
      facilities_details: journeyResult.facilities_details || {},
      journies: csvInfo.preview_rows,
      total_journeys: totalJourneys,
      preview_count: maxPreview,
      csv_download_link: csvInfo.csv_link,
      csv_id: csvInfo.csv_id,
      note: `Showing first ${maxPreview} of ${totalJourneys} journeys. Download full results via CSV link.`,
    };

    return JSON.stringify(previewResult, null, 2);
  } catch (error) {
    logger.error(`Error formatting journey list with CSV: ${error}`);
    // Fallback: return original result
    return JSON.stringify(journeyResult, null, 2);
  }
}
