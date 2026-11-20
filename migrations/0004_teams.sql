CREATE TABLE teams (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX teams_owner ON teams(owner);
CREATE TABLE team_members (
 team_id TEXT NOT NULL REFERENCES teams(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('owner','editor','reviewer','viewer')), created_at TEXT NOT NULL,
 PRIMARY KEY(team_id,user_id)
);
CREATE INDEX team_members_user ON team_members(user_id,team_id);
CREATE TABLE team_invites (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), email TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('editor','reviewer','viewer')), expires INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(team_id,email)
);
CREATE INDEX team_invites_email ON team_invites(email,expires);
CREATE TABLE team_projects (
 id TEXT PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id), title TEXT NOT NULL, description TEXT NOT NULL,
 creator TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX team_projects_team ON team_projects(team_id);
CREATE TABLE team_submissions (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES team_projects(id), owner TEXT NOT NULL REFERENCES users(id),
 source_id TEXT NOT NULL REFERENCES entries(id), title TEXT NOT NULL, revision INTEGER NOT NULL, version INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','changes_requested','approved','withdrawn')), updated_at TEXT NOT NULL
);
CREATE INDEX team_submissions_project ON team_submissions(project_id,updated_at);
CREATE TABLE team_versions (
 submission_id TEXT NOT NULL REFERENCES team_submissions(id), version INTEGER NOT NULL,
 owner TEXT NOT NULL REFERENCES users(id), snapshot TEXT NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(submission_id,version)
);
CREATE TABLE team_events (
 id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES team_submissions(id),
 owner TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL,
 version INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('submit','comment','approved','changes_requested','withdrawn')),
 text TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX team_events_submission ON team_events(submission_id,created_at);
CREATE TRIGGER team_limits BEFORE INSERT ON teams BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM teams WHERE owner=NEW.owner)>=3 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_member_limits BEFORE INSERT ON team_members BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM team_members WHERE team_id=NEW.team_id)>=30 OR
 (SELECT COUNT(*) FROM team_members WHERE user_id=NEW.user_id)>=20 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_invite_limits BEFORE INSERT ON team_invites BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM team_invites WHERE team_id=NEW.team_id AND expires>unixepoch() AND email<>NEW.email)>=30
 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_project_limits BEFORE INSERT ON team_projects BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM team_projects WHERE team_id=NEW.team_id)>=20 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_submission_limits BEFORE INSERT ON team_submissions BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM team_submissions JOIN team_projects ON project_id=team_projects.id
 WHERE team_id=(SELECT team_id FROM team_projects WHERE id=NEW.project_id))>=100 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_version_limits BEFORE INSERT ON team_versions BEGIN
 SELECT CASE WHEN NEW.version>30 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_event_limits BEFORE INSERT ON team_events WHEN NEW.kind<>'withdrawn' BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM team_events WHERE submission_id=NEW.submission_id)>=200 THEN RAISE(ABORT,'TEAM_LIMIT') END;
END;
CREATE TRIGGER team_metadata_usage AFTER INSERT ON teams BEGIN
 INSERT INTO document_usage VALUES('team:metadata:'||NEW.id,NEW.owner,length(CAST(NEW.name AS BLOB))+256);
END;
CREATE TRIGGER team_project_usage AFTER INSERT ON team_projects BEGIN
 INSERT INTO document_usage VALUES('team:project:'||NEW.id,NEW.creator,length(CAST(NEW.title||NEW.description AS BLOB))+256);
END;
CREATE TRIGGER team_version_usage AFTER INSERT ON team_versions BEGIN
 INSERT INTO document_usage VALUES('team:version:'||NEW.submission_id||':'||NEW.version,NEW.owner,length(CAST(NEW.snapshot AS BLOB)));
END;
CREATE TRIGGER team_event_usage AFTER INSERT ON team_events WHEN NEW.kind<>'withdrawn' BEGIN
 INSERT INTO document_usage VALUES('team:event:'||NEW.id,NEW.owner,length(CAST(NEW.text||NEW.actor_name AS BLOB))+256);
END;
