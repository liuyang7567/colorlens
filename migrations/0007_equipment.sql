CREATE TABLE equipment_devices (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL, metadata TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('available','maintenance','retired')), revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(scope,code)
);
CREATE INDEX equipment_scope ON equipment_devices(scope,updated_at);
CREATE TABLE equipment_bookings (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES equipment_devices(id), owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('confirmed','cancelled','completed')),
 revision INTEGER NOT NULL, actual_start INTEGER, actual_end INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK(ends_at>starts_at), CHECK((actual_start IS NULL AND actual_end IS NULL) OR (actual_start IS NOT NULL AND actual_end>actual_start))
);
CREATE INDEX equipment_booking_time ON equipment_bookings(device_id,starts_at,ends_at,status);
CREATE TRIGGER equipment_no_overlap_insert BEFORE INSERT ON equipment_bookings WHEN NEW.status='confirmed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM equipment_bookings WHERE device_id=NEW.device_id AND status='confirmed' AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
 THEN RAISE(ABORT,'BOOKING_CONFLICT') END;
END;
CREATE TRIGGER equipment_no_overlap_update BEFORE UPDATE ON equipment_bookings WHEN NEW.status='confirmed' BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM equipment_bookings WHERE device_id=NEW.device_id AND id<>NEW.id AND status='confirmed' AND starts_at<NEW.ends_at AND ends_at>NEW.starts_at)
 THEN RAISE(ABORT,'BOOKING_CONFLICT') END;
END;
CREATE TABLE equipment_events (
 id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES equipment_devices(id), owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','edit','maintenance','available','retire','book','cancel','complete')),
 data TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(device_id,revision)
);
CREATE TRIGGER equipment_device_limit BEFORE INSERT ON equipment_devices BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM equipment_devices WHERE scope=NEW.scope)>=100 THEN RAISE(ABORT,'EQUIPMENT_LIMIT') END;
END;
CREATE TRIGGER equipment_booking_limit BEFORE INSERT ON equipment_bookings BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM equipment_bookings WHERE device_id=NEW.device_id)>=500 THEN RAISE(ABORT,'EQUIPMENT_LIMIT') END;
END;
CREATE TRIGGER equipment_event_limit BEFORE INSERT ON equipment_events WHEN NEW.kind<>'cancel' BEGIN
 SELECT CASE WHEN NEW.revision>1200 THEN RAISE(ABORT,'EQUIPMENT_LIMIT') END;
END;
CREATE TRIGGER equipment_event_usage AFTER INSERT ON equipment_events WHEN NEW.kind<>'cancel' BEGIN
 INSERT INTO document_usage VALUES('equipment:event:'||NEW.id,NEW.owner,length(CAST(NEW.data||NEW.reason||NEW.actor_name AS BLOB))+512);
END;
