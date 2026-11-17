export const normalizedSchema = `
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    installation_id TEXT NOT NULL CHECK(length(installation_id) > 0),
    gateway_serial TEXT NOT NULL CHECK(length(gateway_serial) > 0),
    device_id TEXT NOT NULL CHECK(length(device_id) > 0),
    name TEXT NOT NULL CHECK(length(name) > 0),
    UNIQUE(installation_id, gateway_serial, device_id)
  ) STRICT;
  CREATE TABLE selected_devices (
    device_id INTEGER PRIMARY KEY REFERENCES devices(id) ON DELETE RESTRICT,
    position INTEGER NOT NULL UNIQUE CHECK(position >= 0)
  ) STRICT;
  CREATE TABLE active_device (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    device_id INTEGER NOT NULL REFERENCES selected_devices(device_id) ON DELETE RESTRICT
  ) STRICT;
  CREATE TABLE sensors_v2 (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    sensor TEXT NOT NULL CHECK(length(sensor) > 0),
    label TEXT NOT NULL CHECK(length(label) > 0),
    kind TEXT NOT NULL CHECK(kind IN ('flow', 'water', 'other')),
    UNIQUE(device_id, sensor)
  ) STRICT;
  CREATE TABLE readings_v2 (
    sensor_id INTEGER NOT NULL REFERENCES sensors_v2(id) ON DELETE RESTRICT,
    timestamp INTEGER NOT NULL CHECK(timestamp BETWEEN 0 AND 9007199254740991),
    value REAL NOT NULL CHECK(value BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
    PRIMARY KEY(sensor_id, timestamp)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE schedule_programs (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    schedules TEXT NOT NULL CHECK(json_valid(schedules) AND json_type(schedules) = 'array'),
    UNIQUE(device_id, schedules),
    UNIQUE(device_id, id)
  ) STRICT;
  CREATE TABLE schedule_snapshots_v2 (
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
    timestamp INTEGER NOT NULL CHECK(timestamp BETWEEN 0 AND 9007199254740991),
    poll_seconds INTEGER NOT NULL CHECK(poll_seconds BETWEEN 1 AND 9007199254740991),
    program_id INTEGER NOT NULL,
    error TEXT,
    PRIMARY KEY(device_id, timestamp),
    FOREIGN KEY(device_id, program_id) REFERENCES schedule_programs(device_id, id) ON DELETE RESTRICT
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX schedule_snapshots_program ON schedule_snapshots_v2(device_id, program_id);
  CREATE TABLE settings_v2 (
    key TEXT PRIMARY KEY NOT NULL CHECK(length(key) > 0), value TEXT NOT NULL
  ) STRICT, WITHOUT ROWID;

  INSERT INTO devices(installation_id, gateway_serial, device_id, name)
  SELECT json_extract(device, '$[0]'), json_extract(device, '$[1]'),
    json_extract(device, '$[2]'), device
  FROM (
    SELECT device FROM sensors UNION SELECT device FROM readings
    UNION SELECT device FROM schedule_snapshots
    UNION SELECT json_array(json_extract(value, '$.installationId'),
      json_extract(value, '$.gatewaySerial'), json_extract(value, '$.deviceId'))
      FROM settings WHERE key = 'device'
    UNION SELECT json_array(json_extract(j.value, '$.installationId'),
      json_extract(j.value, '$.gatewaySerial'), json_extract(j.value, '$.deviceId'))
      FROM settings, json_each(settings.value) AS j WHERE settings.key = 'devices'
  );
  UPDATE devices SET name = COALESCE((
    SELECT json_extract(value, '$.name') FROM settings WHERE key = 'device'
    AND json_extract(value, '$.installationId') = devices.installation_id
    AND json_extract(value, '$.gatewaySerial') = devices.gateway_serial
    AND json_extract(value, '$.deviceId') = devices.device_id
  ), name);
  UPDATE devices SET name = COALESCE((
    SELECT json_extract(j.value, '$.name') FROM settings, json_each(settings.value) AS j
    WHERE settings.key = 'devices'
    AND json_extract(j.value, '$.installationId') = devices.installation_id
    AND json_extract(j.value, '$.gatewaySerial') = devices.gateway_serial
    AND json_extract(j.value, '$.deviceId') = devices.device_id
  ), name);
  INSERT INTO selected_devices(device_id, position)
  SELECT d.id, CAST(j.key AS INTEGER)
  FROM settings, json_each(settings.value) AS j JOIN devices d
    ON d.installation_id = json_extract(j.value, '$.installationId')
    AND d.gateway_serial = json_extract(j.value, '$.gatewaySerial')
    AND d.device_id = json_extract(j.value, '$.deviceId')
  WHERE settings.key = 'devices';
  INSERT INTO selected_devices(device_id, position)
  SELECT d.id, 0 FROM devices d JOIN settings s
    ON d.installation_id = json_extract(s.value, '$.installationId')
    AND d.gateway_serial = json_extract(s.value, '$.gatewaySerial')
    AND d.device_id = json_extract(s.value, '$.deviceId')
  WHERE s.key = 'device' AND NOT EXISTS(SELECT 1 FROM settings WHERE key = 'devices');
  INSERT INTO active_device(singleton, device_id)
  SELECT 1, d.id FROM selected_devices s JOIN devices d ON d.id = s.device_id
  ORDER BY (json_array(d.installation_id, d.gateway_serial, d.device_id) = (
    SELECT json_array(json_extract(value, '$.installationId'),
      json_extract(value, '$.gatewaySerial'), json_extract(value, '$.deviceId'))
    FROM settings WHERE key = 'device'
  )) DESC, s.position LIMIT 1;
  INSERT INTO sensors_v2(device_id, sensor, label, kind)
  SELECT d.id, s.sensor, s.label, s.kind FROM sensors s JOIN devices d
    ON json_array(d.installation_id, d.gateway_serial, d.device_id) = s.device;
  INSERT INTO readings_v2(sensor_id, timestamp, value)
  SELECT s.id, r.timestamp, r.value FROM readings r JOIN devices d
    ON json_array(d.installation_id, d.gateway_serial, d.device_id) = r.device
    JOIN sensors_v2 s ON s.device_id = d.id AND s.sensor = r.sensor;
  INSERT INTO schedule_programs(device_id, schedules)
  SELECT DISTINCT d.id, s.schedules FROM schedule_snapshots s JOIN devices d
    ON json_array(d.installation_id, d.gateway_serial, d.device_id) = s.device;
  INSERT INTO schedule_snapshots_v2(device_id, timestamp, poll_seconds, program_id, error)
  SELECT d.id, s.timestamp, s.poll_seconds, p.id, s.error
    FROM schedule_snapshots s JOIN devices d
    ON json_array(d.installation_id, d.gateway_serial, d.device_id) = s.device
    JOIN schedule_programs p ON p.device_id = d.id AND p.schedules = s.schedules;
  INSERT INTO settings_v2 SELECT key, value FROM settings WHERE key NOT IN ('device', 'devices');

  CREATE TEMP TABLE migration_counts (
    valid INTEGER NOT NULL CHECK(valid = 1)
  ) STRICT;
  INSERT INTO migration_counts VALUES (
    (SELECT count(*) FROM sensors) = (SELECT count(*) FROM sensors_v2)
    AND (SELECT count(*) FROM readings) = (SELECT count(*) FROM readings_v2)
    AND (SELECT count(*) FROM schedule_snapshots) = (SELECT count(*) FROM schedule_snapshots_v2)
  );
  DROP TABLE migration_counts;
  DROP TABLE readings;
  DROP TABLE sensors;
  DROP TABLE schedule_snapshots;
  DROP TABLE settings;
  ALTER TABLE sensors_v2 RENAME TO sensors;
  ALTER TABLE readings_v2 RENAME TO readings;
  ALTER TABLE schedule_snapshots_v2 RENAME TO schedule_snapshots;
  ALTER TABLE settings_v2 RENAME TO settings;
`;
