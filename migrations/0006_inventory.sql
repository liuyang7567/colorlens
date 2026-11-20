CREATE TABLE purchase_requests (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), creator TEXT NOT NULL REFERENCES users(id), doc TEXT NOT NULL,
 unit TEXT NOT NULL, quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 1 AND 999999999999999),
 received INTEGER NOT NULL CHECK(typeof(received)='integer' AND received BETWEEN 0 AND quantity),
 estimated_cents INTEGER NOT NULL CHECK(typeof(estimated_cents)='integer' AND estimated_cents BETWEEN 0 AND 99999999999),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled','partial','received','closed')),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX purchase_team ON purchase_requests(team_id,updated_at);
CREATE TABLE inventory_lots (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, creator TEXT NOT NULL REFERENCES users(id), code TEXT NOT NULL, unit TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity BETWEEN 0 AND 999999999999999),
 minimum INTEGER NOT NULL CHECK(typeof(minimum)='integer' AND minimum BETWEEN 0 AND 999999999999999), metadata TEXT NOT NULL,
 revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('active','archived')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(scope,code), CHECK(status<>'archived' OR quantity=0)
);
CREATE INDEX inventory_scope ON inventory_lots(scope,status,updated_at);
CREATE TABLE inventory_events (
 id TEXT PRIMARY KEY, lot_id TEXT NOT NULL REFERENCES inventory_lots(id), owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','consume','add','correct','edit','retire','restore','dispose','receive')),
 delta INTEGER NOT NULL CHECK(typeof(delta)='integer'), balance INTEGER NOT NULL CHECK(typeof(balance)='integer'),
 data TEXT NOT NULL, reason TEXT NOT NULL, purchase_id TEXT REFERENCES purchase_requests(id), created_at TEXT NOT NULL,
 UNIQUE(lot_id,revision)
);
CREATE TABLE purchase_events (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_requests(id), owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('create','approve','reject','cancel','close','receive','comment')),
 data TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(purchase_id,revision)
);
CREATE TABLE inventory_receipts (
 id TEXT PRIMARY KEY, purchase_id TEXT NOT NULL REFERENCES purchase_requests(id), lot_id TEXT NOT NULL REFERENCES inventory_lots(id),
 owner TEXT NOT NULL REFERENCES users(id), reference TEXT NOT NULL, fingerprint TEXT NOT NULL,
 quantity INTEGER NOT NULL CHECK(typeof(quantity)='integer' AND quantity>0), created_at TEXT NOT NULL,
 UNIQUE(purchase_id,reference)
);
CREATE INDEX inventory_receipt_lot ON inventory_receipts(lot_id,created_at);
CREATE TRIGGER inventory_lot_limit BEFORE INSERT ON inventory_lots BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM inventory_lots WHERE scope=NEW.scope)>=500 THEN RAISE(ABORT,'INVENTORY_LIMIT') END;
END;
CREATE TRIGGER inventory_event_limit BEFORE INSERT ON inventory_events BEGIN
 SELECT CASE WHEN NEW.revision>160 THEN RAISE(ABORT,'INVENTORY_LIMIT') END;
END;
CREATE TRIGGER purchase_limit BEFORE INSERT ON purchase_requests BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM purchase_requests WHERE team_id=NEW.team_id)>=200 THEN RAISE(ABORT,'INVENTORY_LIMIT') END;
END;
CREATE TRIGGER purchase_event_limit BEFORE INSERT ON purchase_events BEGIN
 SELECT CASE WHEN NEW.revision>160 THEN RAISE(ABORT,'INVENTORY_LIMIT') END;
END;
CREATE TRIGGER inventory_receipt_limit BEFORE INSERT ON inventory_receipts BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM inventory_receipts WHERE purchase_id=NEW.purchase_id)>=100 THEN RAISE(ABORT,'INVENTORY_LIMIT') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM purchase_requests JOIN inventory_lots ON inventory_lots.id=NEW.lot_id
 WHERE purchase_requests.id=NEW.purchase_id AND inventory_lots.scope='team:'||purchase_requests.team_id AND inventory_lots.unit=purchase_requests.unit)
 THEN RAISE(ABORT,'INVENTORY_SCOPE') END;
END;
CREATE TRIGGER inventory_identity BEFORE UPDATE ON inventory_lots BEGIN
 SELECT CASE WHEN NEW.scope<>OLD.scope OR NEW.code<>OLD.code OR NEW.unit<>OLD.unit OR
 json_extract(NEW.metadata,'$.manufacturer')<>json_extract(OLD.metadata,'$.manufacturer') OR
 json_extract(NEW.metadata,'$.catalogue')<>json_extract(OLD.metadata,'$.catalogue') OR
 json_extract(NEW.metadata,'$.lot')<>json_extract(OLD.metadata,'$.lot') THEN RAISE(ABORT,'INVENTORY_SCOPE') END;
END;
CREATE TRIGGER purchase_identity BEFORE UPDATE ON purchase_requests BEGIN
 SELECT CASE WHEN NEW.team_id<>OLD.team_id OR NEW.creator<>OLD.creator OR NEW.unit<>OLD.unit OR NEW.quantity<>OLD.quantity OR
 NEW.doc<>OLD.doc OR NEW.estimated_cents<>OLD.estimated_cents THEN RAISE(ABORT,'INVENTORY_SCOPE') END;
END;
CREATE TRIGGER inventory_event_usage AFTER INSERT ON inventory_events BEGIN
 INSERT INTO document_usage VALUES('inventory:event:'||NEW.id,NEW.owner,length(CAST(NEW.data||NEW.reason||NEW.actor_name AS BLOB))+512);
END;
CREATE TRIGGER purchase_event_usage AFTER INSERT ON purchase_events BEGIN
 INSERT INTO document_usage VALUES('purchase:event:'||NEW.id,NEW.owner,length(CAST(NEW.data||NEW.reason||NEW.actor_name AS BLOB))+512);
END;
CREATE TRIGGER inventory_receipt_usage AFTER INSERT ON inventory_receipts BEGIN
 INSERT INTO document_usage VALUES('inventory:receipt:'||NEW.id,NEW.owner,length(CAST(NEW.reference AS BLOB))+512);
END;
