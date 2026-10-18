import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config, requireConfig } from './config.js';
import { initPool } from './db.js';
import { resendSender, addressOf } from './email.js';
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
  google: config.googleClientId ? { clientId: config.googleClientId, clientSecret: config.googleClientSecret, tenantId: config.sandboxTenantId, publicUrl: config.publicUrl || undefined } : undefined,
  email: config.resendApiKey ? {
    send: resendSender(config.resendApiKey), from: config.emailFrom, replyTo: config.emailReplyTo || undefined,
    // With inbound turned on, each reply-to carries the case number, like support+c123@yourdomain.com.
    caseReplyTo: config.resendWebhookSecret ? ((n: number) => addressOf(config.emailFrom).replace(/^([^@]+)@/, `$1+c${n}@`)) : undefined,
  } : undefined,
  inbound: config.resendWebhookSecret ? { secret: config.resendWebhookSecret, apiKey: config.resendApiKey, tenantId: config.sandboxTenantId } : undefined,
  uiDir: fileURLToPath(new URL('../ui', import.meta.url)),
});
await app.listen({ port: config.port, host: '0.0.0.0' });
