export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',
  port: Number(process.env.PORT ?? 3000),
  // Stopgap login for a one person sandbox. Replace with SSO before anyone else uses this.
  sandboxLoginKey: process.env.SANDBOX_LOGIN_KEY ?? '',
  sandboxTenantId: process.env.SANDBOX_TENANT_ID ?? '',
  // Stopgap login for a one person sandbox. Replace with SSO before anyone else uses this.
};

export function requireConfig() {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push('DATABASE_URL');
  if (config.jwtSecret.length < 32) missing.push('JWT_SECRET (at least 32 characters)');
  if (config.sandboxLoginKey && (config.sandboxLoginKey.length < 32 || !config.sandboxTenantId)) missing.push('SANDBOX_LOGIN_KEY (32+ characters) together with SANDBOX_TENANT_ID');
  if (missing.length) throw new Error(`Missing config: ${missing.join(', ')}`);
}
