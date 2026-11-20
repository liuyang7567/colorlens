CREATE TABLE guidance_runs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id),
 data TEXT NOT NULL, revision INTEGER NOT NULL, epoch TEXT NOT NULL DEFAULT '',
 consent_until INTEGER NOT NULL DEFAULT 0, interval_s INTEGER NOT NULL DEFAULT 30,
 max_calls INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, last_call INTEGER NOT NULL DEFAULT 0,
 busy_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX guidance_owner ON guidance_runs(owner,entry_id,created_at);
CREATE TABLE guidance_events (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES guidance_runs(id), owner TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, fingerprint TEXT NOT NULL,
 created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX guidance_event_run ON guidance_events(owner,run_id,created_at);
CREATE TRIGGER guidance_run_scope BEFORE INSERT ON guidance_runs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM entries WHERE id=NEW.entry_id AND owner=NEW.owner) THEN RAISE(ABORT,'GUIDANCE_SCOPE') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM guidance_runs WHERE owner=NEW.owner)>=20 THEN RAISE(ABORT,'GUIDANCE_LIMIT') END;
END;
CREATE TRIGGER guidance_event_scope BEFORE INSERT ON guidance_events BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM guidance_runs WHERE id=NEW.run_id AND owner=NEW.owner) THEN RAISE(ABORT,'GUIDANCE_SCOPE') END;
 SELECT CASE WHEN (SELECT COUNT(*) FROM guidance_events WHERE run_id=NEW.run_id)>=150 THEN RAISE(ABORT,'GUIDANCE_LIMIT') END;
END;
CREATE TRIGGER guidance_run_usage AFTER INSERT ON guidance_runs BEGIN
 INSERT INTO document_usage VALUES('guidance:'||NEW.id||':'||NEW.revision,NEW.owner,length(CAST(NEW.data AS BLOB))+512);
END;
CREATE TRIGGER guidance_run_version_usage AFTER UPDATE OF revision ON guidance_runs WHEN NEW.revision<>OLD.revision BEGIN
 INSERT INTO document_usage VALUES('guidance:'||NEW.id||':'||NEW.revision,NEW.owner,length(CAST(NEW.data AS BLOB))+512);
END;
CREATE TRIGGER guidance_event_usage AFTER INSERT ON guidance_events BEGIN
 INSERT INTO document_usage VALUES('guidance-event:'||NEW.id,NEW.owner,60000);
END;
CREATE TRIGGER guidance_ai_quota BEFORE INSERT ON guidance_events WHEN NEW.kind='vision' BEGIN
 SELECT CASE WHEN (SELECT used FROM ai_budgets WHERE day=substr(NEW.created_at,1,10) AND scope='global')>=100 OR
 (SELECT used FROM ai_budgets WHERE day=substr(NEW.created_at,1,10) AND scope=NEW.owner)>=10 THEN RAISE(ABORT,'AI_QUOTA') END;
 INSERT INTO ai_budgets VALUES(substr(NEW.created_at,1,10),'global',1) ON CONFLICT(day,scope) DO UPDATE SET used=used+1;
 INSERT INTO ai_budgets VALUES(substr(NEW.created_at,1,10),NEW.owner,1) ON CONFLICT(day,scope) DO UPDATE SET used=used+1;
END;
