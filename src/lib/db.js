import { neon } from '@neondatabase/serverless';

/** Create a Neon SQL client from the Worker secret. No Supabase calls are made. */
export function createDb(env) {
  if (!env.NEON_DATABASE_URL) {
    throw new Error('NEON_DATABASE_URL is not configured for this Worker.');
  }
  return neon(env.NEON_DATABASE_URL);
}
