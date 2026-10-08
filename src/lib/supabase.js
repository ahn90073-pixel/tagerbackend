import { createClient } from '@supabase/supabase-js';

/**
 * Creates a Supabase client bound to the Workers environment.
 * Uses the service role key for privileged access (bypasses RLS).
 *
 * In production, SUPABASE_SERVICE_ROLE_KEY and JWT_SECRET are set via
 * `wrangler secret put`. In local dev, they come from .dev.vars.
 */
export function createSupabaseClient(env) {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
