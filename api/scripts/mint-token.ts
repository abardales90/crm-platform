// Sandbox login: prints a token for one user. Real login (SSO) comes later.
// Usage: DATABASE_URL=... JWT_SECRET=... npm run token -- <tenant_id> <email> [hours]
import { initPool, withTenant, closePool } from '../src/db.js';
import { signToken } from '../src/auth.js';
import { config, requireConfig } from '../src/config.js';

requireConfig();
const [tenantId, email, hours] = process.argv.slice(2);
if (!tenantId || !email) { console.error('Usage: npm run token -- <tenant_id> <email> [hours]'); process.exit(1); }
initPool(config.databaseUrl);
const user = await withTenant({ tenantId, userId: '00000000-0000-0000-0000-000000000000', actorType: 'system' }, async (db) =>
  (await db.query(`SELECT id, status FROM app_user WHERE email = lower($1) AND deleted_at IS NULL`, [email])).rows[0]);
await closePool();
if (!user) { console.error('No such user in that tenant'); process.exit(1); }
if (user.status === 'disabled') { console.error('That user is disabled'); process.exit(1); }
console.log(signToken(config.jwtSecret, { tenantId, userId: user.id }, Number(hours ?? 24) * 3600));
