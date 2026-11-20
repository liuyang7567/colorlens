ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN email_verified_at TEXT;
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
UPDATE users SET display_name=username;
CREATE UNIQUE INDEX unique_login_email ON users(email) WHERE email IS NOT NULL;
ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
CREATE TABLE email_codes (
 id TEXT PRIMARY KEY, email TEXT NOT NULL, purpose TEXT NOT NULL,
 user_id TEXT REFERENCES users(id) ON DELETE CASCADE, user_version INTEGER,
 code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
 expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX email_code_expiry ON email_codes(expires);
CREATE INDEX email_code_user ON email_codes(user_id,purpose);
