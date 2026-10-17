import pg from 'pg';
import { randomUUID } from 'node:crypto';

export type Ctx = { tenantId: string; userId: string; requestId?: string; actorType?: 'user' | 'system' | 'ai' };
export type Db = pg.PoolClient;

// Return plain calendar dates as text ('2026-12-31'). The default turns them into timestamps and can shift the day.
pg.types.setTypeParser(1082, (v: string) => v);

let pool: pg.Pool | undefined;

export function initPool(connectionString: string) {
  pool = new pg.Pool({ connectionString, max: 10 });
  // Hosted databases (Neon sleeps when idle) drop idle connections. Log it and carry on; the pool reconnects.
  pool.on('error', (e) => console.error('idle database connection dropped:', e.message));
  return pool;
}

export async function closePool() {
  await pool?.end();
  pool = undefined;
}

// Every query for a request runs inside this. The tenant is set for this transaction only,
// so a pooled connection can never carry one tenant's id into another request.
export async function withTenant<T>(ctx: Ctx, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('database pool not initialised');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      `SELECT set_config('app.tenant_id', $1, true),
              set_config('app.user_id', $2, true),
              set_config('app.actor_type', $3, true),
              set_config('app.request_id', $4, true)`,
      [ctx.tenantId, ctx.userId, ctx.actorType ?? 'user', ctx.requestId ?? randomUUID()],
    );
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}
