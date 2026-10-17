import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../src/migrate.js';

const ADMIN = process.env.TEST_ADMIN_URL ?? 'postgresql://postgres@/postgres?host=/var/lib/postgresql/crm_test/sock&port=54329';
const DB = `crm_mig_test_${process.pid}`;
const url = ADMIN.replace('/postgres?', `/${DB}?`);

describe('startup migrations', () => {
  afterAll(async () => {
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.end();
  });

  it('applies new files once, skips done ones, and rolls back a bad file', async () => {
    const a = new pg.Client({ connectionString: ADMIN }); await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();

    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_a.sql'), `CREATE TABLE t1 (id int);`);
    writeFileSync(join(dir, '0002_b.sql'), `CREATE TABLE t2 (id int);`);
    expect(await runMigrations(url, dir)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(await runMigrations(url, dir)).toEqual([]);

    writeFileSync(join(dir, '0003_bad.sql'), `CREATE TABLE t3 (id int); SELECT 1/0;`);
    await expect(runMigrations(url, dir)).rejects.toThrow(/0003_bad.sql failed and was rolled back/);
    writeFileSync(join(dir, '0003_bad.sql'), `CREATE TABLE t3 (id int);`);
    expect(await runMigrations(url, dir)).toEqual(['0003_bad.sql']); // t3 was not left behind, so it creates cleanly

    const c = new pg.Client({ connectionString: url }); await c.connect();
    const r = await c.query(`SELECT filename FROM schema_migrations ORDER BY filename`);
    await c.end();
    expect(r.rows.map((x) => x.filename)).toEqual(['0001_a.sql', '0002_b.sql', '0003_bad.sql']);
  });
});
