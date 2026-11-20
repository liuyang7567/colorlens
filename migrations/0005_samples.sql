CREATE TABLE sample_boxes (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL REFERENCES users(id),
 freezer TEXT NOT NULL, rack TEXT NOT NULL, name TEXT NOT NULL, storage_condition TEXT NOT NULL,
 rows INTEGER NOT NULL CHECK(rows BETWEEN 1 AND 16), columns INTEGER NOT NULL CHECK(columns BETWEEN 1 AND 24),
 path_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(scope,path_key)
);
CREATE INDEX sample_boxes_scope ON sample_boxes(scope);
CREATE TABLE lab_samples (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL,
 unit TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 0 AND 999999999999999), metadata TEXT NOT NULL,
 parent_id TEXT REFERENCES lab_samples(id), box_id TEXT REFERENCES sample_boxes(id), slot TEXT,
 revision INTEGER NOT NULL CHECK(revision>=1), status TEXT NOT NULL CHECK(status IN ('active','archived')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(scope,code),
 CHECK((box_id IS NULL AND slot IS NULL) OR (box_id IS NOT NULL AND slot IS NOT NULL)),
 CHECK(status<>'archived' OR (quantity=0 AND box_id IS NULL))
);
CREATE INDEX samples_scope ON lab_samples(scope,status,updated_at);
CREATE INDEX samples_parent ON lab_samples(parent_id);
CREATE UNIQUE INDEX samples_slot ON lab_samples(box_id,slot) WHERE box_id IS NOT NULL;
CREATE TABLE sample_events (
 id TEXT PRIMARY KEY, sample_id TEXT NOT NULL REFERENCES lab_samples(id), owner TEXT NOT NULL REFERENCES users(id),
 actor_name TEXT NOT NULL, revision INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('create','edit','add','consume','correct','move','aliquot','retire','restore')),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer'), balance INTEGER NOT NULL CHECK(typeof(balance)='integer'), data TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(sample_id,revision)
);
CREATE INDEX sample_events_sample ON sample_events(sample_id,revision);
CREATE TABLE sample_links (
 sample_id TEXT NOT NULL REFERENCES lab_samples(id), owner TEXT NOT NULL REFERENCES users(id),
 entry_id TEXT NOT NULL REFERENCES entries(id), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at TEXT NOT NULL, PRIMARY KEY(sample_id,owner,entry_id)
);
CREATE INDEX sample_links_entry ON sample_links(owner,entry_id,active);
CREATE TRIGGER sample_box_limit BEFORE INSERT ON sample_boxes BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM sample_boxes WHERE scope=NEW.scope)>=40 THEN RAISE(ABORT,'SAMPLE_LIMIT') END;
END;
CREATE TRIGGER sample_limit BEFORE INSERT ON lab_samples BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM lab_samples WHERE scope=NEW.scope)>=500 THEN RAISE(ABORT,'SAMPLE_LIMIT') END;
END;
CREATE TRIGGER sample_location_insert BEFORE INSERT ON lab_samples BEGIN
 SELECT CASE WHEN NEW.box_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sample_boxes WHERE id=NEW.box_id AND scope=NEW.scope)
 OR NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM lab_samples WHERE id=NEW.parent_id AND scope=NEW.scope AND unit=NEW.unit)
 THEN RAISE(ABORT,'SAMPLE_SCOPE') END;
END;
CREATE TRIGGER sample_location_update BEFORE UPDATE ON lab_samples BEGIN
 SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.unit<>OLD.unit OR NEW.parent_id IS NOT OLD.parent_id OR
 NEW.box_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sample_boxes WHERE id=NEW.box_id AND scope=NEW.scope)
 THEN RAISE(ABORT,'SAMPLE_SCOPE') END;
END;
CREATE TRIGGER sample_event_limit BEFORE INSERT ON sample_events BEGIN
 SELECT CASE WHEN NEW.revision>160 THEN RAISE(ABORT,'SAMPLE_LIMIT') END;
END;
CREATE TRIGGER sample_link_limit BEFORE INSERT ON sample_links WHEN NOT EXISTS(SELECT 1 FROM sample_links WHERE sample_id=NEW.sample_id AND owner=NEW.owner AND entry_id=NEW.entry_id) BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM sample_links WHERE owner=NEW.owner)>=1000 OR
 (SELECT COUNT(*) FROM sample_links WHERE owner=NEW.owner AND entry_id=NEW.entry_id)>=100 THEN RAISE(ABORT,'SAMPLE_LIMIT') END;
END;
CREATE TRIGGER sample_box_usage AFTER INSERT ON sample_boxes BEGIN
 INSERT INTO document_usage VALUES('sample:box:'||NEW.id,NEW.creator,length(CAST(NEW.freezer||NEW.rack||NEW.name||NEW.storage_condition AS BLOB))+512);
END;
CREATE TRIGGER sample_event_usage AFTER INSERT ON sample_events BEGIN
 INSERT INTO document_usage VALUES('sample:event:'||NEW.id,NEW.owner,length(CAST(NEW.data||NEW.reason||NEW.actor_name AS BLOB))+512);
END;
CREATE TRIGGER sample_link_usage AFTER INSERT ON sample_links BEGIN
 INSERT INTO document_usage VALUES('sample:link:'||NEW.sample_id||':'||NEW.owner||':'||NEW.entry_id,NEW.owner,512);
END;
