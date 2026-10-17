import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Applies any migration files that have not run yet, oldest first.
// Each file runs in its own transaction together with its record in schema_migrations,
// so a failed file leaves nothing half done. A lock stops two copies of the app from migrating at once.
export async function runMigrations(url: string, dir: string, log: (m: string) => void = () => {}) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 20_000 });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    for (const f of files) {
      await client.query('BEGIN');
      try {
        await client.query(`SELECT pg_advisory_xact_lock(7240001)`);
        const done = await client.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [f]);
        if (done.rowCount) { await client.query('COMMIT'); continue; }
        await client.query(readFileSync(join(dir, f), 'utf8'));
        await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`migration applied: ${f}`);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${f} failed and was rolled back: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return applied;
}
