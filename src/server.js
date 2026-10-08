import app from './app.js';
import { config } from './config/env.js';
import { pool } from './config/db.js';

async function start() {
  try {
    // Verify database connection
    await pool.query('SELECT 1');
    console.log('[db] Connected successfully');

    app.listen(config.port, () => {
      console.log(`[server] Running on port ${config.port} (${config.nodeEnv})`);
      console.log(`[server] Health check: http://localhost:${config.port}/health`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();
