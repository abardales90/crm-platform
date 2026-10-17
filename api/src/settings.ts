import type { FastifyInstance } from 'fastify';
import { type Kit, UUID } from './kit.js';
import { ApiError } from './errors.js';
import type { Db } from './db.js';
import { EmailError, type EmailConfig } from './email.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const USER_SQL = `
  SELECT u.id, u.email, u.display_name, u.status, u.last_login_at, u.version,
         (SELECT ur.role_id FROM user_role ur WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id LIMIT 1) AS role_id,
         (SELECT r.name FROM user_role ur JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
           WHERE ur.tenant_id = u.tenant_id AND ur.user_id = u.id ORDER BY r.name LIMIT 1) AS role_name
    FROM app_user u WHERE u.deleted_at IS NULL`;

// Another active or invited Tenant Admin exists besides this user?
async function otherAdminExists(db: Db, exceptUserId: string) {
  const r = await db.query(
    `SELECT 1 FROM user_role ur
       JOIN role r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id AND r.name = 'Tenant Admin'
       JOIN app_user u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
      WHERE u.id <> $1 AND u.deleted_at IS NULL AND u.status <> 'disabled' LIMIT 1`, [exceptUserId]);
  return (r.rowCount ?? 0) > 0;
}

export function settingsRoutes(app: FastifyInstance, kit: Kit, email: EmailConfig | undefined, signin: { google: boolean; key: boolean }) {
  const { authed, can } = kit;

  app.get('/v1/settings/workspace', async (req) =>
    authed(req, async (db) => {
      const t = (await db.query(`SELECT name, default_currency FROM tenant`)).rows[0];
      return { name: t.name, default_currency: t.default_currency, email: { configured: !!email, from: email?.from ?? null }, signin };
    }));

  app.patch('/v1/settings/workspace', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      const name = String((req.body as any)?.name ?? '').trim();
      if (!name) throw new ApiError(400, 'bad_request', 'Give the workspace a name');
      if (name.length > 120) throw new ApiError(400, 'bad_request', 'That name is too long');
      await db.query(`UPDATE tenant SET name = $1`, [name]);
      return { name };
    }));

  app.get('/v1/settings/roles', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'role', 'read');
      const r = await db.query(`SELECT id, name, description FROM role WHERE deleted_at IS NULL ORDER BY name`);
      return { data: r.rows };
    }));

  app.get('/v1/settings/users', async (req) =>
    authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'read');
      const r = await db.query(`${USER_SQL} ORDER BY u.display_name`);
      return { data: r.rows };
    }));

  app.post('/v1/settings/users', async (req, reply) => {
    const row = await authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'create');
      const b: any = req.body ?? {};
      const addr = String(b.email ?? '').trim().toLowerCase();
      const name = String(b.display_name ?? '').trim();
      if (!EMAIL.test(addr)) throw new ApiError(400, 'bad_request', 'Enter a valid email address');
      if (!name) throw new ApiError(400, 'bad_request', 'Enter a name');
      if (typeof b.role_id !== 'string' || !UUID.test(b.role_id)) throw new ApiError(400, 'bad_request', 'Choose a role');
      const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
      const u = (await db.query(
        `INSERT INTO app_user (tenant_id, email, display_name, status) VALUES ($1, $2, $3, 'invited') RETURNING id`,
        [tenantId, addr, name])).rows[0];
      await db.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [tenantId, u.id, b.role_id]);
      return (await db.query(`${USER_SQL} AND u.id = $1`, [u.id])).rows[0];
    });
    return reply.status(201).send(row);
  });

  app.patch('/v1/settings/users/:id', async (req) =>
    authed(req, async (db, userId) => {
      const { id } = req.params as { id: string };
      if (!UUID.test(id)) throw new ApiError(404, 'not_found', 'Not found');
      await can(db, userId, 'app_user', 'edit');
      const b: any = req.body ?? {};
      if (!Number.isInteger(b.version)) throw new ApiError(400, 'version_required', 'Send the version you last read');

      const cur = (await db.query(`${USER_SQL} AND u.id = $1`, [id])).rows[0];
      if (!cur) throw new ApiError(404, 'not_found', 'Not found');

      const sets: string[] = []; const args: unknown[] = [];
      if (b.display_name !== undefined) {
        const n = String(b.display_name).trim();
        if (!n) throw new ApiError(400, 'bad_request', 'Enter a name');
        args.push(n); sets.push(`display_name = $${args.length + 2}`);
      }
      const wasAdmin = cur.role_name === 'Tenant Admin';
      if (b.status !== undefined) {
        if (!['active', 'disabled'].includes(b.status)) throw new ApiError(400, 'bad_request', 'Status must be active or disabled');
        if (b.status === 'disabled' && id === userId) throw new ApiError(400, 'cannot_lock_yourself_out', 'You cannot turn off your own account');
        if (b.status === 'disabled' && wasAdmin && !(await otherAdminExists(db, id))) throw new ApiError(400, 'last_admin', 'This is the last Tenant Admin. Make someone else an admin first');
        args.push(b.status); sets.push(`status = $${args.length + 2}`);
      }
      const roleChange = b.role_id !== undefined && b.role_id !== cur.role_id;
      if (roleChange) {
        if (typeof b.role_id !== 'string' || !UUID.test(b.role_id)) throw new ApiError(400, 'bad_request', 'Choose a role');
        if (id === userId) throw new ApiError(400, 'cannot_lock_yourself_out', 'You cannot change your own role');
        if (wasAdmin && !(await otherAdminExists(db, id))) throw new ApiError(400, 'last_admin', 'This is the last Tenant Admin. Make someone else an admin first');
      }
      if (!sets.length && !roleChange) throw new ApiError(400, 'bad_request', 'Nothing to change');
      if (!sets.length) sets.push('display_name = display_name'); // touch the row so the version moves

      const r = await db.query(`UPDATE app_user SET ${sets.join(', ')} WHERE id = $1 AND version = $2 AND deleted_at IS NULL RETURNING id`, [id, b.version, ...args]);
      if (r.rowCount === 0) throw new ApiError(409, 'version_conflict', 'Someone else changed this person. Reload and try again', { current_version: cur.version });
      if (roleChange) {
        const tenantId = (await db.query(`SELECT current_tenant_id() AS t`)).rows[0].t;
        await db.query(`DELETE FROM user_role WHERE user_id = $1`, [id]);
        await db.query(`INSERT INTO user_role (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [tenantId, id, b.role_id]);
      }
      return (await db.query(`${USER_SQL} AND u.id = $1`, [id])).rows[0];
    }));

  // Sends a test message to the signed in person, so email can be checked without a customer.
  app.post('/v1/settings/email-test', async (req) => {
    const prep = await authed(req, async (db, userId) => {
      await can(db, userId, 'app_user', 'edit');
      if (!email) throw new ApiError(503, 'email_not_configured', 'Email is not set up yet. Add RESEND_API_KEY and EMAIL_FROM in Render, then try again.');
      const u = (await db.query(`SELECT email, display_name FROM app_user WHERE id = $1`, [userId])).rows[0];
      return u as { email: string; display_name: string };
    });
    try {
      await email!.send({ from: email!.from, to: prep.email, subject: 'Test email from your CRM', text: `Hi ${prep.display_name.split(' ')[0]},\n\nThis is a test. If you can read it, your CRM can send email.`, replyTo: email!.replyTo });
    } catch (e) {
      if (e instanceof EmailError) throw new ApiError(502, 'email_failed', e.message);
      throw e;
    }
    return { sent_to: prep.email };
  });
}
