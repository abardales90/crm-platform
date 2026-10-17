import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initPool, closePool } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { signToken } from '../src/auth.js';
import { EmailError, type OutgoingEmail } from '../src/email.js';

export const LOGIN_KEY = 'login-key-login-key-login-key-login-key-1234';
export const SECRET = 'test-secret-test-secret-test-secret-123456';
const ADMIN = process.env.TEST_ADMIN_URL ?? 'postgresql://postgres@/postgres?host=/var/lib/postgresql/crm_test/sock&port=54329';
const DBNAME = `crm_api_test_${process.pid}`;

export type World = Awaited<ReturnType<typeof setup>>;

// Builds a throwaway database, applies every migration, makes two tenants with users in
// different roles, and returns an API wired to a non superuser login (so RLS really applies).
export async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DBNAME}`);
  await admin.query(`CREATE DATABASE ${DBNAME}`);
  const dbUrl = (user: string) => ADMIN.replace('/postgres?', `/${DBNAME}?`).replace('//postgres@', `//${user}@`);
  const root = new pg.Client({ connectionString: dbUrl('postgres') });
  await root.connect();
  const dir = join(__dirname, '../migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await root.query(readFileSync(join(dir, f), 'utf8'));
  await root.query(`CREATE ROLE api_test_login LOGIN IN ROLE crm_app`);

  const tenants: Record<string, { id: string; users: Record<string, string>; roles: Record<string, string> }> = {};
  for (const [key, slug] of [['a', 'tenant-a'], ['b', 'tenant-b']] as const) {
    const id = (await root.query(`SELECT provision_tenant($1, $2, $3, $4) AS id`, [`Tenant ${key}`, slug, `admin@${slug}.test`, `Admin ${key}`])).rows[0].id;
    await root.query(`SELECT set_config('app.tenant_id', $1, false)`, [id]);
    const roles: Record<string, string> = {};
    for (const r of (await root.query(`SELECT id, name FROM role WHERE tenant_id = $1`, [id])).rows) roles[r.name] = r.id;
    const users: Record<string, string> = {};
    users.admin = (await root.query(`SELECT id FROM app_user WHERE tenant_id = $1`, [id])).rows[0].id;
    for (const [label, role] of [['sales', 'Sales'], ['agent', 'Support Agent'], ['finance', 'Finance Viewer']] as const) {
      const u = (await root.query(
        `INSERT INTO app_user (tenant_id, email, display_name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [id, `${label}@${slug}.test`, label])).rows[0].id;
      await root.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [id, u, roles[role]]);
      users[label] = u;
    }
    tenants[key] = { id, users, roles };
  }
  // Support Agents must not see account revenue in tenant A.
  await root.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenants.a.id]);
  await root.query(`INSERT INTO field_permission (tenant_id, role_id, object, field, access) VALUES ($1, $2, 'account', 'annual_revenue', 'none')`,
    [tenants.a.id, tenants.a.roles['Support Agent']]);
  await root.end();

  // A pretend email provider: records what would be sent, or fails on demand.
  const mail = { sent: [] as OutgoingEmail[], failWith: undefined as string | undefined };
  const fakeSend = async (m: OutgoingEmail) => {
    if (mail.failWith) throw new EmailError(mail.failWith);
    mail.sent.push(m);
    return { id: `fake-${mail.sent.length}` };
  };

  initPool(dbUrl('api_test_login'));
  const app = buildApp({ jwtSecret: SECRET, sandboxLogin: { key: LOGIN_KEY, tenantId: tenants.a.id },
    email: { send: fakeSend, from: 'Support <support@example.test>' } });
  await app.ready();

  const as = (t: 'a' | 'b', user: string) => ({ authorization: `Bearer ${signToken(SECRET, { tenantId: tenants[t].id, userId: tenants[t].users[user] })}` });
  const call = async (method: string, url: string, headers: Record<string, string>, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, headers, payload: payload as any });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  // Superuser SQL for setting up situations the API cannot (it bypasses row level security, so always name the tenant).
  let su: pg.Client | undefined;
  const sql = async (text: string, params?: unknown[]) => {
    if (!su) { su = new pg.Client({ connectionString: dbUrl('postgres') }); await su.connect(); }
    return su.query(text, params);
  };
  const teardown = async () => {
    await su?.end();
    await app.close();
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS api_test_login`);
    await admin.end();
  };
  return { tenants, as, call, teardown, app, mail, sql };
}
