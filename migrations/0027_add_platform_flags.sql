-- Migration: Add platform_flags table for runtime feature kill-switches (OPS-01)
-- Description: Single-row-per-flag table; allows disabling features without restart/redeploy
-- Usage: UPDATE platform_flags SET value = FALSE, updated_at = NOW() WHERE key = 'community_relayer_enabled';

CREATE TABLE IF NOT EXISTS platform_flags (
  key TEXT PRIMARY KEY,
  value BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- Seed the relayer kill-switch flag (defaults OFF per Phase 2 D-17)
INSERT INTO platform_flags (key, value)
VALUES ('community_relayer_enabled', FALSE)
ON CONFLICT DO NOTHING;
