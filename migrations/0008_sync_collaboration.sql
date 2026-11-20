CREATE TABLE sync_operations (
 owner TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id),
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner,operation_id)
);
CREATE TRIGGER sync_operation_limit BEFORE INSERT ON sync_operations BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM sync_operations WHERE owner=NEW.owner)>=2000 THEN RAISE(ABORT,'SYNC_LIMIT') END;
END;
CREATE TRIGGER sync_operation_usage AFTER INSERT ON sync_operations BEGIN
 INSERT INTO document_usage VALUES('sync:'||NEW.owner||':'||NEW.operation_id,NEW.owner,256);
END;
CREATE TABLE collaboration_documents (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id),
 project_id TEXT NOT NULL REFERENCES team_projects(id), creator TEXT NOT NULL REFERENCES users(id),
 data TEXT NOT NULL, revision INTEGER NOT NULL, sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX collaboration_team ON collaboration_documents(team_id,updated_at);
CREATE TABLE collaboration_versions (
 document_id TEXT NOT NULL REFERENCES collaboration_documents(id), revision INTEGER NOT NULL,
 owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 data TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(document_id,revision)
);
CREATE TABLE collaboration_operations (
 owner TEXT NOT NULL REFERENCES users(id), operation_id TEXT NOT NULL,
 document_id TEXT NOT NULL REFERENCES collaboration_documents(id), fingerprint TEXT NOT NULL,
 revision INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(owner,operation_id)
);
CREATE TABLE collaboration_presence (
 document_id TEXT NOT NULL REFERENCES collaboration_documents(id), user_id TEXT NOT NULL REFERENCES users(id),
 field TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(document_id,user_id)
);
CREATE TRIGGER collaboration_limit BEFORE INSERT ON collaboration_documents BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM collaboration_documents WHERE team_id=NEW.team_id)>=40 THEN RAISE(ABORT,'COLLAB_LIMIT') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM team_projects WHERE id=NEW.project_id AND team_id=NEW.team_id) THEN RAISE(ABORT,'COLLAB_SCOPE') END;
END;
CREATE TRIGGER collaboration_version_limit BEFORE INSERT ON collaboration_versions BEGIN
 SELECT CASE WHEN NEW.revision>2000 THEN RAISE(ABORT,'COLLAB_LIMIT') END;
END;
CREATE TRIGGER collaboration_version_usage AFTER INSERT ON collaboration_versions BEGIN
 INSERT INTO document_usage VALUES('collaboration:'||NEW.document_id||':'||NEW.revision,NEW.owner,length(CAST(NEW.data AS BLOB))+512);
END;
