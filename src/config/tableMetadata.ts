/**
 * Table Metadata Configuration
 * 
 * This module contains manually configured table information including:
 * - Table names
 * - Descriptions (use cases)
 * - Important fields
 * 
 * This data is used by the get_table_list tool to provide table information
 * to the LLM without querying the database.
 */

export interface TableMetadata {
  name: string;
  description: string;
  importantFields: string[];
}

export const TABLE_METADATA: TableMetadata[] = [
  {
    name: 'device_alerts',
    description: 'Stores device alert data including battery alerts, temperature alerts (min/max), and light alerts with event timestamps',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (UNIQUE, links to device_details_table.device_id)',
      'battery, battery_event_time, battery_sensor_id',
      'min_temperature, min_temperature_event_time, min_temperature_sensor_id',
      'max_temperature, max_temperature_event_time, max_temperature_sensor_id',
      'light, light_event_time, light_id',
    ],
  },
  {
    name: 'device_current_data',
    description: 'Stores current/latest device data including location, temperature, battery, facility, and event timestamps. Use for list of devices that experienced shock (or free-fall) after a date: select device_id, device_name, shock_event_time (or free_fall_event_time) from device_current_data joined with user_device_assignment; do NOT use shock_info for list-by-date (shock_info is full history and slow).',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (UNIQUE, links to device_details_table.device_id)',
      'device_name, grai_id, imei',
      'latitude, longitude, h3_id, location_type',
      'facility_id (links to facilities.facility_id)',
      'facility_type (links to facilities.facility_type)',
      'event_time, timestamp',
      'temperature, battery',
      'travel_distance, dwell_time_seconds, dwell_time',
      'shock_id (links to shock_info.id)',
      'shock_event_time (use for "devices that experienced shock after date" - do not join shock_info)',
      'free_fall_id (links to shock_info.id)',
      'free_fall_event_time (use for free-fall after date - do not join shock_info)',
      'updated_at',
    ],
  },
  {
    name: 'device_details_table',
    description: 'Stores device configuration, metadata, and latest sensor/message references. Contains device settings, thresholds, and device information',
    importantFields: [
      'sno (PRIMARY KEY)',
      'device_id (UNIQUE)',
      'device_name, device_type',
      'imei, grai_id, iccid, imsi',
      'temp_min_threshold',
      'temp_max_threshold',
      'battery_min_threshold',
      'network_min_threshold',
      'humidity_min_threshold',
      'humidity_max_threshold',
      'light_threshold',
      'dwell_time_max_threshold',
    ],
  },
  {
    name: 'user_device_assignment',
    description: 'Maps users to their assigned devices for access control',
    importantFields: [
      'id (PRIMARY KEY)',
      'user_id (links to admin.user_id)',
      'device (links to device_details_table.device_id and other-table.device_id)',
    ],
  },  
  {
    name: 'device_geofencings',
    description: 'Stores geofencing events tracking device entry and exit from facilities. Records when devices enter/exit specific facility',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id (links to device_details_table.device_id)',
      'facility_type, facility_id',
      'entry_event_time',
      'exit_event_time',
      'facility_last_event_time',
    ],
  },
  {
    name: 'facilities',
    description: 'Stores facility/location information including addresses, coordinates, and geofencing data. Represents warehouses, distribution centers, stores, etc.',
    importantFields: [
      'id (PRIMARY KEY)',
      'facility_id (UNIQUE)',
      'facility_name, facility_type',
      'latitude, longitude',
      'street, city, state, zip_code',
      'company_id (to filter admin role=2, links to admin.company_id for role_id=2)',
      'is_active',
      'created_at',
      'updated_at',
      'deleted_at',
    ],
  },{
    name: 'admin',
    description: 'Stores user information including role_id, company_id',
    importantFields: [
      'id (PRIMARY KEY)',
      'user_id (UNIQUE)',
      'role_id (1: super-admin, 2: user, 3: sub-user)',
      'company_id',
    ],
  },{
    name: 'facility_sub_users',
    description: 'Stores facility sub-user information including user_id, facility_id',
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
      'device_id',
      'timestamp',
      'event_time (data collection time)',
      'latitude',
      'longitude',
      'temperature',
      'battery',
      'facility_id',
      'facility_type',
      'dwell_time (dwell time human readable : 7d, 2h, 10m)',
      'dwell_timestamp (dwell time in seconds)',
      'travel_distance (travel distance in meters)',
      'address (JSON)',
      'accuracy',
      'altitude',
    ],
  },
  {
    name: 'light_data',
    description: 'Stores light sensor readings from devices. Records light intensity measurements at specific event times',
    importantFields: [
      'id (PRIMARY KEY)',
      'imt_id (links to incoming_message_history_k.imt_id)',
      'device_id',
      'event_time',
      'light (integer)',
    ],
  },
  {
    name: 'sensor',
    description: 'Stores sensor readings including temperature, battery, and shock data. Links to incoming messages via imt_id',
    importantFields: [
      'id (PRIMARY KEY)',
      'imt_id (UNIQUE, links to incoming_message_history_k.imt_id)',
      'device_id',
      'temperature, battery, accurate_battery',
      'event_time',
    ],
  },
  {
    name: 'shock_info',
    description: 'Full history of shock/free-fall events (one row per event). For "list of devices that experienced shock after [date]" or "who and when" use device_current_data.shock_event_time instead - do NOT join shock_info for that (table is large and query will timeout).',
    importantFields: [
      'id (PRIMARY KEY)',
      'device_id',
      'type (shock,free_fall)',
      'time_stamp',
    ],
  },
];
