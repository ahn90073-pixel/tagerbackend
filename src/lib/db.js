import { neon } from '@neondatabase/serverless';

/** Create a Neon SQL client from the Worker secret. No Supabase calls are made. */
export function createDb(env) {
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured for this Worker.');
  }
  return neon(env.DATABASE_URL);
}
