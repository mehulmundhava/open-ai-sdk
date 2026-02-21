-- Area bounds table: stores POLYGON/MULTIPOLYGON for locations resolved by get_area_bounds tool.
-- Run once. Requires PostGIS extension.
-- The LLM uses area_bound_id from the tool response to JOIN this table and filter with ST_Contains(ab.boundary, point).

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE area_bounds (
  id SERIAL PRIMARY KEY,
  area_name TEXT NOT NULL,
  boundary GEOMETRY(Geometry, 4326) NOT NULL,
  location_params JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_area_bounds_boundary ON area_bounds USING GIST (boundary);

-- Optional: unique constraint on area_name for deduplication (uncomment if you want one row per area_name)
-- CREATE UNIQUE INDEX idx_area_bounds_area_name ON area_bounds (area_name);
