import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { config, requireConfig } from './config.js';
import { initPool } from './db.js';
import { resendSender } from './email.js';

requireConfig();
initPool(config.databaseUrl);
const app = buildApp({
  jwtSecret: config.jwtSecret, logger: true, trustProxy: true,
  sandboxLogin: config.sandboxLoginKey ? { key: config.sandboxLoginKey, tenantId: config.sandboxTenantId } : undefined,
  email: config.resendApiKey ? { send: resendSender(config.resendApiKey), from: config.emailFrom, replyTo: config.emailReplyTo || undefined } : undefined,
  uiDir: fileURLToPath(new URL('../ui', import.meta.url)),
});
await app.listen({ port: config.port, host: '0.0.0.0' });
