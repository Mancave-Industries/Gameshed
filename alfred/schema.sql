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

CREATE TABLE IF NOT EXISTS claude_pilot (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    proposal TEXT NOT NULL,
    revision TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER,
    result TEXT
);

CREATE TABLE IF NOT EXISTS chat_grants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    challenge TEXT NOT NULL,
    state TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
