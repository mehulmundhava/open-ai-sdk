/**
 * Table Metadata Configuration
 * 
 * This module contains manually configured table information including:
 * - Table names
 * - Descriptions (use cases)
 * - Important fields
 * 
 * This data is used by get_table_list (name, description) and get_tables_important_fields (name, importantFields) to provide table information to the LLM without querying the database.
 */

export interface TableMetadata {
  name: string;
  description: string;
  importantFields: string[];
}

export const TABLE_METADATA: TableMetadata[] = [
  {
    name: 'device_alerts',
    description: 'Stores device alert data including battery alerts, contain fields for battery, min_temperature, max_temperature, light, min_temperature_event_time, max_temperature_event_time, battery_event_time, light_event_time',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string,UNIQUE, links to device_details_table.device_id)',
      'battery (float)', 'battery_event_time (timestamp)', 'battery_sensor_id (string, links to sensor.id)',
      'min_temperature (float)', 'min_temperature_event_time (timestamp)', 'min_temperature_sensor_id (string, links to sensor.id)',
      'max_temperature (float)', 'max_temperature_event_time (timestamp)', 'max_temperature_sensor_id (string, links to sensor.id)',
      'light (float)', 'light_event_time (timestamp)', 'light_id (string, links to light_data.id)',
    ],
  },
  {
    name : 'device_settings_data',
    description: 'Stores device settings like alert thresholds. alert threshols fiels id, device_id, ltth (low temperature threshold), htth (high temperature threshold), ltdth (low temperature duration threshold), htdth (high temperature duration threshold), lbth (low battery threshold), hdth (high dwell time threshold)',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string,UNIQUE, links to device_details_table.device_id)',
      'ltth (float)', 'htth (float)', 'ltdth (integer)', 'htdth (integer)', 'lbth (integer)', 'hdth (integer)',
    ],
  },
  {
    name : 'device_settings_history',
    description: 'Stores device settings threshold history . fiels id, device_id, name(string :ltth, htth, ltdth, htdth, lbth, hdth), value (string), start_time(timestamp), end_time(timestamp), value_type(string :real, integer, string)',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string,UNIQUE, links to device_details_table.device_id)',
      'name (string :ltth, htth, ltdth, htdth, lbth, hdth)', 
      'value (float, integer, string)', 
      'start_time(timestamp)', 
      'end_time(timestamp)',
      'value_type(string :real, integer)',
    ],
  },
  {
    name: 'device_current_data',
    description: 'Stores current/latest device data including location, temperature, battery, facility, and event_time(last location time), timestamp(last reported time),shock_event_time(last shock time),free_fall_event_time(last free-fall time). Use for list of devices that experienced shock (or free-fall) after a date: select device_id, device_name, shock_event_time (or free_fall_event_time) from device_current_data joined with user_device_assignment; do NOT use shock_info for list-by-date (shock_info is full history and slow).',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string,UNIQUE, links to device_details_table.device_id)',
      'device_name (string)', 'grai_id (string)', 'imei (string)',
      'latitude (float)', 'longitude (float)', 'h3_id (string)', 'location_type (string)',
      'facility_id (string, links to facilities.facility_id)',
      'facility_type (string, eg. M, R, U, D, etc., links to facilities.facility_type)',
      'event_time (timestamp, last location time)', 'timestamp (timestamp, last reported time)',
      'temperature (float)', 'battery (float)',
      'travel_distance (bigint, in meters)', 'dwell_time_seconds (integer, in seconds)', 'dwell_time (string, eg. 1D, 2H, 10M)',
      'shock_id (bigint, links to shock_info.id)',
      'shock_event_time (timestamp, use for "devices that experienced shock at a specific time" - do not join shock_info)',
      'free_fall_id (bigint, links to shock_info.id)',
      'free_fall_event_time (timestamp, use for "devices that experienced free-fall at a specific time" - do not join shock_info)',
      'updated_at (timestamp, last reported time)',
    ],
  },
  {
    name: 'device_details_table',
    description: 'Stores device configuration, metadata, and latest sensor/message references. Contains device settings, thresholds, and device information',
    importantFields: [
      'sno (PRIMARY KEY)',
      'device_id (string,UNIQUE)',
      'device_name (string)',
      'device_type (string, eg. M, R, U, D, etc.)',
      'imei (string)', 'grai_id (string)', 'iccid (string)', 'imsi (string)',

    ],
  },
  {
    name: 'user_device_assignment',
    description: 'Maps users to their assigned devices for access control',
    importantFields: [
      'id (PRIMARY KEY)',
      'user_id (integer, links to admin.id)',
      'device (string, links to device_details_table.device_id and other-table.device_id)',
    ],
  },  
  {
    name: 'device_geofencings',
    description: 'Stores geofencing events tracking device entry and exit from facilities. Records when devices enter/exit specific facility',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string, links to device_details_table.device_id)',
      'facility_type (string, eg. M, R, U, D, etc.)',
      'facility_id (string, links to facilities.facility_id)',
      'entry_event_time (timestamp)',
      'exit_event_time (timestamp)',
      'facility_last_event_time (timestamp)',
    ],
  },
  {
    name: 'facilities',
    description: 'Stores facility/location information including addresses, coordinates, and geofencing data. Represents warehouses, distribution centers, stores, etc.',
    importantFields: [
      'id (PRIMARY KEY)',
      'facility_id (string,UNIQUE)',
      'facility_name (string)',
      'facility_type (string, eg. M, R, U, D, etc.)',
      'latitude (float)',
      'longitude (float)',
      'street (string)', 'city (string)', 'state (string)', 'zip_code (string)',
      'company_id (to filter admin role=2, links to admin.company_id for role_id=2)',
      'is_active (integer, 0=inactive, 1=active)',
    ],
  },{
    name: 'admin',
    description: 'Stores user information including role_id, company_id',
    importantFields: [
      'id (PRIMARY KEY)',
      'user_id (integer,UNIQUE)',
      'role_id (1: super-admin, 2: user, 3: sub-user)',
      'company_id (integer, links to admin.company_id for role_id=2)',
    ],
  },{
    name: 'facility_sub_users',
    description: 'Stores facility sub-user(role_id=2 in admin table) information including user_id, facility_id',
    importantFields: [
      'id (PRIMARY KEY)',
      'user_id (links to admin.user_id for role_id=2)',
      'facility_id (links to facilities.facility_id)',
    ],
  },  
  {
    name: 'incoming_message_history_k',
    description: 'Stores historical incoming messages from devices. Contains location data, temperature, battery, facility information, and movement data over time',
    importantFields: [
      'sno (PRIMARY KEY)',
      'device_id (string, links to device_details_table.device_id)',
      'timestamp (timestamp, device reported time)',
      'event_time (data collection time)',
      'latitude (float)',
      'longitude (float)',
      'temperature (float, in degrees Celsius)',
      'battery (integer, in percentage)',
      'facility_id (string, links to facilities.facility_id)',
      'facility_type (string, eg. M, R, U, D, etc.)',
      'dwell_time (dwell time human readable : 7d, 2h, 10m)',
      'dwell_timestamp (dwell time in seconds)',
      'travel_distance (travel distance in meters)',
      'address (JSON)',
      'accuracy (float, in meters)',
      'altitude (integer, in meters)',
    ],
  },
  {
    name: 'light_data',
    description: 'Stores light sensor readings from devices. Records light intensity measurements at specific event times',
    importantFields: [
      'id (PRIMARY KEY)',
      'imt_id (integer, links to incoming_message_history_k.sno)',
      'device_id (string, links to device_details_table.device_id)',
      'event_time (timestamp, event time)',
      'light (integer, in lux)',
    ],
  },
  {
    name: 'sensor',
    description: 'Stores sensor readings including temperature, battery, and shock data. Links to incoming messages via imt_id',
    importantFields: [
      'id (PRIMARY KEY)',
      'imt_id (UNIQUE, links to incoming_message_history_k.imt_id)',
      'device_id (string, links to device_details_table.device_id)',
      'temperature (float, in degrees Celsius)',
      'battery (integer, in percentage)',
      // 'accurate_battery (integer, in percentage)',
      'event_time (timestamp, event time)',
    ],
  },
  {
    name: 'shock_info',
    description: 'Full history of shock/free-fall events (one row per event). For "list of devices that experienced shock after [date]" or "who and when" use device_current_data.shock_event_time instead - do NOT join shock_info for that (table is large and query will timeout).',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string, links to device_details_table.device_id or other-table.device_id)',
      'type (string, eg. shock, free_fall)',
      'time_stamp (timestamp, event time)',
    ],
  },
  {
    name: 'area_bounds',
    description: 'Stores geographic boundaries (polygon/multipolygon) for locations resolved by get_area_bounds tool. Use the id returned by get_area_bounds to JOIN and filter by ST_Contains(ab.boundary, point).',
    importantFields: [
      'id (PRIMARY KEY) - use area_bound_id from get_area_bounds tool',
      'area_name (string)',
      'boundary (geometry, use with ST_Contains for geographic filter)',
      'location_params (jsonb)',
      'created_at (timestamp)',
    ],
  },
  {
    name: 'device_temperature_alert',
    description: 'Stores temperature alert history with device_id,start_time,end_time,type(0=min,1=max),threshold_value(min or max allowed value),threshold_duration( minimum duration in seconds to generate alert),status(0=inactive,1=active).',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (string, links to device_details_table.device_id or other-table.device_id)',
      'start_time (timestamp)',
      'end_time (timestamp)',
      'type (integer, eg. 0=min temperature alert,1=max temperature alert )',
      'threshold_value(float, min or max allowed value for temperature)',
      'threshold_duration( integer, minimum duration in seconds to generate alert)',
      'status(integer, 0=inactive,1=active)',
    ],
  },
];
