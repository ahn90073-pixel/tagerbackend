-- Long-lived, rotating refresh sessions. Raw refresh tokens are never stored.
CREATE TABLE IF NOT EXISTS public.auth_refresh_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_refresh_sessions_user_active_idx
  ON public.auth_refresh_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;
