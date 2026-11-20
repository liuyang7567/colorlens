PRAGMA foreign_keys = ON;
CREATE TABLE users (
 id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'member', disabled INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, invite_hash TEXT,
 doc_bytes INTEGER NOT NULL DEFAULT 0, file_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_initial_admin ON users(role) WHERE role='admin';
CREATE TABLE sessions (
 hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL
);
CREATE INDEX session_user ON sessions(user_id);
CREATE TABLE invites (
 hash TEXT PRIMARY KEY, remaining INTEGER NOT NULL, expires INTEGER NOT NULL,
 creator TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TRIGGER consume_invite AFTER INSERT ON users WHEN NEW.invite_hash IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM invites WHERE hash=NEW.invite_hash AND remaining>0 AND expires>unixepoch()) THEN RAISE(ABORT,'INVITE_INVALID') END;
 UPDATE invites SET remaining=remaining-1 WHERE hash=NEW.invite_hash;
END;
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE entries (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), doc TEXT NOT NULL,
 revision INTEGER NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX entry_owner ON entries(owner,updated_at);
CREATE TABLE revisions (
 entry_id TEXT NOT NULL REFERENCES entries(id), owner TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, snapshot TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(entry_id,revision)
);
CREATE INDEX revision_owner ON revisions(owner,entry_id,revision);
CREATE TABLE usage_totals (id INTEGER PRIMARY KEY, doc_bytes INTEGER NOT NULL, file_bytes INTEGER NOT NULL);
INSERT INTO usage_totals VALUES(1,0,0);
CREATE TABLE mutation_guard (value INTEGER NOT NULL CHECK(value=1));
CREATE TABLE document_usage (key TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES users(id),size INTEGER NOT NULL);
CREATE TRIGGER document_quota BEFORE INSERT ON document_usage BEGIN
 SELECT CASE WHEN NEW.size>450000 OR
 (SELECT doc_bytes FROM users WHERE id=NEW.owner)+NEW.size>10485760 OR
 (SELECT doc_bytes FROM usage_totals WHERE id=1)+NEW.size>41943040
 THEN RAISE(ABORT,'DOCUMENT_QUOTA') END;
END;
CREATE TRIGGER document_count AFTER INSERT ON document_usage BEGIN
 UPDATE users SET doc_bytes=doc_bytes+NEW.size WHERE id=NEW.owner;
 UPDATE usage_totals SET doc_bytes=doc_bytes+NEW.size WHERE id=1;
END;
CREATE TRIGGER revision_usage AFTER INSERT ON revisions BEGIN
 INSERT INTO document_usage VALUES('revision:'||NEW.entry_id||':'||NEW.revision,NEW.owner,length(CAST(NEW.snapshot AS BLOB)));
END;
CREATE TRIGGER entry_created AFTER INSERT ON entries BEGIN
 INSERT INTO revisions VALUES(NEW.id,NEW.owner,NEW.revision,NEW.doc,NEW.reason,NEW.updated_at);
END;
CREATE TRIGGER entry_updated AFTER UPDATE ON entries BEGIN
 INSERT INTO revisions VALUES(NEW.id,NEW.owner,NEW.revision,NEW.doc,NEW.reason,NEW.updated_at);
END;
CREATE TABLE files (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id),
 filename TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, chunks INTEGER NOT NULL,
 ready INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX file_owner ON files(owner,entry_id,ready);
CREATE TRIGGER file_quota BEFORE INSERT ON files BEGIN
 SELECT CASE WHEN (SELECT file_bytes FROM users WHERE id=NEW.owner)+NEW.size>52428800 OR
 (SELECT file_bytes FROM usage_totals WHERE id=1)+NEW.size>157286400
 THEN RAISE(ABORT,'FILE_QUOTA') END;
END;
CREATE TRIGGER file_usage AFTER INSERT ON files BEGIN
 UPDATE users SET file_bytes=file_bytes+NEW.size WHERE id=NEW.owner;
 UPDATE usage_totals SET file_bytes=file_bytes+NEW.size WHERE id=1;
END;
CREATE TRIGGER file_deleted AFTER DELETE ON files BEGIN
 UPDATE users SET file_bytes=file_bytes-OLD.size WHERE id=OLD.owner;
 UPDATE usage_totals SET file_bytes=file_bytes-OLD.size WHERE id=1;
END;
CREATE TABLE file_chunks (
 file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE, position INTEGER NOT NULL,
 data TEXT NOT NULL, PRIMARY KEY(file_id,position)
);
CREATE TABLE analyses (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id),
 data TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX analysis_owner ON analyses(owner,entry_id);
CREATE TRIGGER analysis_usage AFTER INSERT ON analyses BEGIN
 INSERT INTO document_usage VALUES('analysis:'||NEW.id,NEW.owner,length(CAST(NEW.data AS BLOB)));
END;
CREATE TABLE ai_runs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), entry_id TEXT NOT NULL REFERENCES entries(id),
 revision INTEGER NOT NULL, input TEXT NOT NULL, input_hash TEXT NOT NULL, task TEXT NOT NULL,
 result TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, model TEXT NOT NULL,
 created_at TEXT NOT NULL, completed_at TEXT
);
CREATE INDEX ai_owner ON ai_runs(owner,entry_id,created_at);
CREATE TRIGGER ai_usage AFTER INSERT ON ai_runs BEGIN
 INSERT INTO document_usage VALUES('ai:'||NEW.id,NEW.owner,200000);
END;
CREATE TABLE ai_budgets (day TEXT NOT NULL, scope TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day,scope));
CREATE TRIGGER ai_quota BEFORE INSERT ON ai_runs BEGIN
 SELECT CASE WHEN (SELECT used FROM ai_budgets WHERE day=substr(NEW.created_at,1,10) AND scope='global')>=100 OR
 (SELECT used FROM ai_budgets WHERE day=substr(NEW.created_at,1,10) AND scope=NEW.owner)>=10
 THEN RAISE(ABORT,'AI_QUOTA') END;
 INSERT INTO ai_budgets VALUES(substr(NEW.created_at,1,10),'global',1) ON CONFLICT(day,scope) DO UPDATE SET used=used+1;
 INSERT INTO ai_budgets VALUES(substr(NEW.created_at,1,10),NEW.owner,1) ON CONFLICT(day,scope) DO UPDATE SET used=used+1;
END;
CREATE TABLE shares (
 id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, owner TEXT NOT NULL REFERENCES users(id),
 entry_id TEXT NOT NULL REFERENCES entries(id), snapshot TEXT NOT NULL, expires INTEGER NOT NULL,
 revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX share_owner ON shares(owner,entry_id);
CREATE TRIGGER share_usage AFTER INSERT ON shares BEGIN
 INSERT INTO document_usage VALUES('share:'||NEW.id,NEW.owner,length(CAST(NEW.snapshot AS BLOB)));
END;
