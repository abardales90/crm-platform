export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  port: Number(process.env.PORT ?? 3000),
  // Stopgap login for a one person sandbox. Replace with SSO before anyone else uses this.
  sandboxLoginKey: process.env.SANDBOX_LOGIN_KEY ?? '',
  sandboxTenantId: process.env.SANDBOX_TENANT_ID ?? '',
  // Email is optional. Without both of these the CRM runs fine and the reply screen says email is not set up.
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  emailFrom: process.env.EMAIL_FROM ?? '',        // for example: Support <support@yourdomain.com>
  emailReplyTo: process.env.EMAIL_REPLY_TO ?? '', // optional
};

export function requireConfig() {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.jwtSecret.length < 32) missing.push('JWT_SECRET (at least 32 characters)');
  if (config.sandboxLoginKey && (config.sandboxLoginKey.length < 32 || !config.sandboxTenantId)) missing.push('SANDBOX_LOGIN_KEY (32+ characters) together with SANDBOX_TENANT_ID');
  if (config.resendApiKey && !config.emailFrom) missing.push('EMAIL_FROM (needed when RESEND_API_KEY is set)');
  if (missing.length) throw new Error(`Missing config: ${missing.join(', ')}`);
}
