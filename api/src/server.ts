import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config, requireConfig } from './config.js';
import { initPool } from './db.js';
import { resendSender } from './email.js';
import { runMigrations } from './migrate.js';

requireConfig();
if (config.migrateDatabaseUrl) {
  // If a migration fails the app stops here, so Render keeps the old working version running.
  const done = await runMigrations(config.migrateDatabaseUrl, fileURLToPath(new URL('../migrations', import.meta.url)), (m) => console.log(m));
  console.log(done.length ? `Database updated: ${done.length} migration(s)` : 'Database is up to date');
}
initPool(config.databaseUrl);
const app = buildApp({
  jwtSecret: config.jwtSecret, logger: true, trustProxy: true,
  sandboxLogin: config.sandboxLoginKey ? { key: config.sandboxLoginKey, tenantId: config.sandboxTenantId } : undefined,
  email: config.resendApiKey ? { send: resendSender(config.resendApiKey), from: config.emailFrom, replyTo: config.emailReplyTo || undefined } : undefined,
  uiDir: fileURLToPath(new URL('../ui', import.meta.url)),
});
await app.listen({ port: config.port, host: '0.0.0.0' });
