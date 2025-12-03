CREATE TABLE IF NOT EXISTS exo_nodes (
  id TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  wallet_address TEXT NOT NULL UNIQUE,
  ip_address TEXT,
  port INTEGER,
  status TEXT DEFAULT 'offline' NOT NULL CHECK (status IN ('online', 'offline')),
  last_seen TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
  contribution_count INTEGER DEFAULT 0 NOT NULL,
  UNIQUE (ip_address, port)
);

CREATE INDEX IF NOT EXISTS idx_exo_nodes_user_id ON exo_nodes(user_id);
CREATE INDEX IF NOT EXISTS idx_exo_nodes_status ON exo_nodes(status);
CREATE INDEX IF NOT EXISTS idx_exo_nodes_wallet_address ON exo_nodes(wallet_address);