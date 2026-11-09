CREATE TABLE IF NOT EXISTS oauth_attempts (
    id TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS github_app (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    credentials TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS claude_rehearsals (
    id TEXT PRIMARY KEY,
    issue_number INTEGER NOT NULL,
    revision TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
);
