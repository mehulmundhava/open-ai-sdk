/**
 * Journey Calculator Service
 *
 * This module implements the journey calculation logic ported from Python.
 * Journey calculation happens in TypeScript, NOT in SQL.
 *
 * Journey Definition:
 * - A journey occurs when a device moves from one facility to another
 * - Journey time must be >= 4 hours (14400 seconds) for different facilities
 * - For same facility (A -> A), minimum time is 4 hours + extraJourneyTimeLimit (if provided)
 */

import { logger } from '../utils/logger';

export interface GeofencingRow {
  device_id: string;
  facility_id: string;
  facility_type?: string;
  facility_name?: string;
  entry_event_time: any; // Can be Date, string, or number (Unix timestamp)
  exit_event_time?: any; // Can be Date, string, or number (Unix timestamp)
}

export interface JourneyCountResult {
  counts: Record<string, number>; // "facilityA||facilityB" -> count
  journey_details: Record<string, {
    count: number;
    from_facility: string;
    to_facility: string;
    from_type: string;
    to_type: string;
  }>;
  total: number;
  metadata: {
    total_rows_processed: number;
    devices_processed: number;
    facility_types_found: string[];
    unique_facilities_found: number;
    facility_type_map: Record<string, string>;
  };
}

export interface JourneyListResult {
  facilities_details: Record<string, {
    facility_id: string;
    facility_type?: string;
    facility_name?: string;
  }>;
  journies: Array<{
    from_facility: string;
    to_facility: string;
    device_id: string;
    journey_time: number | null;
    entry_time: number;
    exit_time: number | null;
  }>;
}

/**
 * Convert various timestamp formats to Unix timestamp (number).
 */
function convertToUnixTimestamp(timestampValue: any): number | null {
  if (timestampValue === null || timestampValue === undefined) {
    return null;
  }

  // If already a number (Unix timestamp)
  if (typeof timestampValue === 'number') {
    return timestampValue;
  }

  // If it's a Date object
  if (timestampValue instanceof Date) {
    return timestampValue.getTime() / 1000; // Convert to seconds
  }

  // If it's a string, try to parse it
  if (typeof timestampValue === 'string') {
    const timestampClean = timestampValue.trim();

    // Try parsing as ISO format
    try {
      // Handle 'Z' timezone indicator
      const cleanTimestamp = timestampClean.endsWith('Z')
        ? timestampClean.slice(0, -1) + '+00:00'
        : timestampClean;

      const date = new Date(cleanTimestamp);
      if (!isNaN(date.getTime())) {
        return date.getTime() / 1000; // Convert to seconds
      }
    } catch (e) {
      // Continue to other parsing methods
    }

    // Try parsing as PostgreSQL timestamp formats
    const formats = [
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d+)$/, // With microseconds
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/, // Without microseconds
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d+)$/, // ISO with microseconds
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/, // ISO without microseconds
    ];

    for (const format of formats) {
      const match = timestampClean.match(format);
      if (match) {
        try {
          // Remove timezone part if present
          const timestampForParse = timestampClean.split('+')[0].split('Z')[0].trim();
          const date = new Date(timestampForParse);
          if (!isNaN(date.getTime())) {
            return date.getTime() / 1000;
          }
        } catch (e) {
          continue;
        }
      }
    }
  }

  logger.warn(`Could not convert timestamp to Unix timestamp: ${timestampValue} (type: ${typeof timestampValue})`);
  return null;
}

/**
 * Validate if the time between two events constitutes a valid journey.
 */
function validJourneyTime(
  fromTime: number | null,
  toTime: number | null,
  isSame: boolean = false,
  extraHours: number | null = null
): boolean {
  if (!fromTime || !toTime) {
    return false;
  }

  // Minimum time limit: 4 hours (14400 seconds)
  let minLimit = 14400;

  // For same facility journeys, add extra hours if provided
  if (isSame && extraHours) {
    minLimit += extraHours * 3600;
  }

  const timeDiff = toTime - fromTime;

  return timeDiff >= minLimit;
}

/**
 * Calculate journey counts from geofencing rows.
 */
export function calculateJourneyCounts(
  geofencingRows: GeofencingRow[],
  extraJourneyTimeLimit: number | null = null
): JourneyCountResult {
  if (!geofencingRows || geofencingRows.length === 0) {
    return {
      counts: {},
      journey_details: {},
      total: 0,
      metadata: {
        total_rows_processed: 0,
        devices_processed: 0,
        facility_types_found: [],
        unique_facilities_found: 0,
        facility_type_map: {},
      },
    };
  }

  // Step 1: Group by device_id
  const deviceMovements: Record<string, GeofencingRow[]> = {};
  for (const row of geofencingRows) {
    const deviceId = String(row.device_id || '');
    if (!deviceId) {
      continue;
    }

    if (!deviceMovements[deviceId]) {
      deviceMovements[deviceId] = [];
    }

    deviceMovements[deviceId].push(row);
  }

  // Step 2: Sort each device's movements by entry_event_time
  for (const deviceId in deviceMovements) {
    deviceMovements[deviceId].sort((a, b) => {
      const timeA = convertToUnixTimestamp(a.entry_event_time) || 0;
      const timeB = convertToUnixTimestamp(b.entry_event_time) || 0;
      return timeA - timeB;
    });
  }

  // Step 3: Process each device's movements
  const journeyCounts: Record<string, number> = {};

  // Track metadata
  const metadata = {
    total_rows: geofencingRows.length,
    devices_processed: Object.keys(deviceMovements).length,
    facility_types_found: new Set<string>(),
    facilities_found: new Set<string>(),
  };

  for (const deviceId in deviceMovements) {
    const movements = deviceMovements[deviceId];
    const visits: Array<{
      facility_id: string;
      facility_type: string;
      entry_time: number;
      exit_time: number | null;
    }> = [];
    const facilityLastIndex: Record<string, number> = {}; // Map of facility_id → most recent visit index

    for (const movement of movements) {
      const facilityId = String(movement.facility_id || '');
      const entryTime = convertToUnixTimestamp(movement.entry_event_time);
      const exitTime = convertToUnixTimestamp(movement.exit_event_time);

      if (entryTime === null) {
        logger.warn(`Invalid entry_time for device ${deviceId}: ${movement.entry_event_time}`);
        continue;
      }

      if (!facilityId) {
        continue;
      }

      // Track metadata
      const facilityType = String(movement.facility_type || '').trim();
      if (facilityType) {
        metadata.facility_types_found.add(facilityType);
      }
      metadata.facilities_found.add(facilityId);

      // Add current visit
      const currentIndex = visits.length;
      visits.push({
        facility_id: facilityId,
        facility_type: facilityType,
        entry_time: entryTime,
        exit_time: exitTime,
      });

      // Generate journeys from all previously visited unique facilities
      if (currentIndex > 0) {
        // Iterate through all previously visited unique facilities
        for (const prevFacilityId in facilityLastIndex) {
          const lastIdx = facilityLastIndex[prevFacilityId];
          if (lastIdx < visits.length && lastIdx >= 0) {
            const targetVisit = visits[lastIdx];
            const fromTime = targetVisit.exit_time;
            const toTime = entryTime;
            const isSameFacility = facilityId === prevFacilityId;

            // Validate journey time
            if (fromTime && toTime && validJourneyTime(fromTime, toTime, isSameFacility, extraJourneyTimeLimit)) {
              // Create journey key: "facilityA||facilityB"
              const journeyKey = `${prevFacilityId}||${facilityId}`;

              // Increment count
              if (!journeyCounts[journeyKey]) {
                journeyCounts[journeyKey] = 0;
              }
              journeyCounts[journeyKey]++;
            }
          }
        }
      }

      // Update facility last index to point to current visit
      facilityLastIndex[facilityId] = currentIndex;
    }
  }

  const total = Object.values(journeyCounts).reduce((sum, count) => sum + count, 0);

  // Build facility type mapping
  const facilityTypeMap: Record<string, string> = {};
  for (const row of geofencingRows) {
    const fid = String(row.facility_id || '');
    const ftype = String(row.facility_type || '').trim();
    if (fid && ftype && !facilityTypeMap[fid]) {
      facilityTypeMap[fid] = ftype;
    }
  }

  // Add facility type information to journey counts
  const journeyDetails: Record<string, {
    count: number;
    from_facility: string;
    to_facility: string;
    from_type: string;
    to_type: string;
  }> = {};

  for (const journeyKey in journeyCounts) {
    const parts = journeyKey.split('||');
    if (parts.length === 2) {
      const [fromFacility, toFacility] = parts;
      const fromType = facilityTypeMap[fromFacility] || '';
      const toType = facilityTypeMap[toFacility] || '';
      journeyDetails[journeyKey] = {
        count: journeyCounts[journeyKey],
        from_facility: fromFacility,
        to_facility: toFacility,
        from_type: fromType,
        to_type: toType,
      };
    }
  }

  return {
    counts: journeyCounts,
    journey_details: journeyDetails,
    total,
    metadata: {
      total_rows_processed: metadata.total_rows,
      devices_processed: metadata.devices_processed,
      facility_types_found: Array.from(metadata.facility_types_found).sort(),
      unique_facilities_found: metadata.facilities_found.size,
      facility_type_map: facilityTypeMap,
    },
  };
}

/**
 * Calculate journey list with facility details.
 */
export function calculateJourneyList(
  geofencingRows: GeofencingRow[],
  extraJourneyTimeLimit: number | null = null,
  fromFacility: string | null = null
): JourneyListResult {
  if (!geofencingRows || geofencingRows.length === 0) {
    return {
      facilities_details: {},
      journies: [],
    };
  }

  // Step 1: Group by device_id
  const deviceMovements: Record<string, GeofencingRow[]> = {};
  const facilitiesDetails: Record<string, {
    facility_id: string;
    facility_type?: string;
    facility_name?: string;
  }> = {};

  for (const row of geofencingRows) {
    const deviceId = String(row.device_id || '');
    if (!deviceId) {
      continue;
    }

    if (!deviceMovements[deviceId]) {
      deviceMovements[deviceId] = [];
    }

    deviceMovements[deviceId].push(row);

    // Collect facility details
    const facilityId = String(row.facility_id || '');
    if (facilityId && !facilitiesDetails[facilityId]) {
      facilitiesDetails[facilityId] = {
        facility_id: facilityId,
        facility_type: row.facility_type,
        facility_name: row.facility_name,
      };
    }
  }

  // Step 2: Sort each device's movements by entry_event_time
  for (const deviceId in deviceMovements) {
    deviceMovements[deviceId].sort((a, b) => {
      const timeA = convertToUnixTimestamp(a.entry_event_time) || 0;
      const timeB = convertToUnixTimestamp(b.entry_event_time) || 0;
      return timeA - timeB;
    });
  }

  // Step 3: Process each device's movements
  const journies: Array<{
    from_facility: string;
    to_facility: string;
    device_id: string;
    journey_time: number | null;
    entry_time: number;
    exit_time: number | null;
  }> = [];

  // Prepare from_facility filter if specified
  const fromFacilityStr = fromFacility ? String(fromFacility).trim() : null;

  for (const deviceId in deviceMovements) {
    const movements = deviceMovements[deviceId];
    const visits: Array<{
      facility_id: string;
      entry_time: number;
      exit_time: number | null;
    }> = [];
    const facilityLastIndex: Record<string, number> = {};

    for (const movement of movements) {
      const facilityId = String(movement.facility_id || '');
      const entryTime = convertToUnixTimestamp(movement.entry_event_time);
      const exitTime = convertToUnixTimestamp(movement.exit_event_time);

      if (entryTime === null) {
        logger.warn(`Invalid entry_time for device ${deviceId}: ${movement.entry_event_time}`);
        continue;
      }

      if (!facilityId) {
        continue;
      }

      // Add current visit
      const currentIndex = visits.length;
      visits.push({
        facility_id: facilityId,
        entry_time: entryTime,
        exit_time: exitTime,
      });

      // Generate journeys from all previously visited unique facilities
      if (currentIndex > 0) {
        // Iterate through all previously visited unique facilities
        for (const prevFacilityId in facilityLastIndex) {
          const lastIdx = facilityLastIndex[prevFacilityId];
          if (lastIdx < visits.length && lastIdx >= 0) {
            const targetVisit = visits[lastIdx];

            // If filtering by from_facility, only create journey if previous facility matches
            if (fromFacilityStr && prevFacilityId !== fromFacilityStr) {
              continue;
            }

            const fromTime = targetVisit.exit_time;
            const toTime = entryTime;
            const isSameFacility = facilityId === prevFacilityId;

            // Validate journey time
            if (fromTime && toTime && validJourneyTime(fromTime, toTime, isSameFacility, extraJourneyTimeLimit)) {
              // Calculate journey time
              const journeyTime = fromTime ? toTime - fromTime : null;

              // Create journey record
              journies.push({
                from_facility: prevFacilityId,
                to_facility: facilityId,
                device_id: deviceId,
                journey_time: journeyTime,
                entry_time: entryTime,
                exit_time: fromTime,
              });
            }
          }
        }
      }

      // Update facility last index to point to current visit
      facilityLastIndex[facilityId] = currentIndex;
    }
  }

  // Filter journeys by from_facility if specified (additional safety check)
  let filteredJournies = journies;
  if (fromFacilityStr) {
    filteredJournies = journies.filter(
      (j) => String(j.from_facility || '').trim() === fromFacilityStr
    );
    logger.info(`Filtered to ${filteredJournies.length} journeys starting from facility ${fromFacilityStr}`);
  }

  return {
    facilities_details: facilitiesDetails,
    journies: filteredJournies,
  };
}
