CREATE TABLE experiment_templates (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
);
CREATE INDEX template_owner ON experiment_templates(owner,updated_at);
CREATE TABLE template_versions (
 template_id TEXT NOT NULL REFERENCES experiment_templates(id), owner TEXT NOT NULL REFERENCES users(id),
 revision INTEGER NOT NULL, data TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(template_id,revision)
);
CREATE TRIGGER template_document_usage AFTER INSERT ON template_versions BEGIN
 INSERT INTO document_usage VALUES('template:'||NEW.template_id||':'||NEW.revision,NEW.owner,length(CAST(NEW.data AS BLOB)));
END;
