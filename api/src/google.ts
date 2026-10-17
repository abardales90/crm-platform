import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { withTenant } from './db.js';
import { signToken } from './auth.js';

// Sign in with Google. People must already be in the People list: Google proves who they are, the list decides who may come in.
export type GoogleIdentity = { iss?: string; aud?: string; exp?: number; nonce?: string; email?: string; email_verified?: boolean };
export type GoogleConfig = {
  clientId: string; clientSecret: string; tenantId: string;
  publicUrl?: string;                                                          // for example https://crm.onrender.com
  exchange?: (code: string, redirectUri: string) => Promise<GoogleIdentity>;   // replaced in tests
};

const COOKIE = 'g_oauth';
const SYSTEM_USER = '00000000-0000-0000-0000-000000000000';

async function googleExchange(cfg: GoogleConfig, code: string, redirectUri: string): Promise<GoogleIdentity> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof j.id_token !== 'string') throw new Error('Google did not accept the sign in');
  // The token came straight from Google over a secure connection, so its contents can be trusted. We still check who it is for and that it is fresh.
  const payload = j.id_token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieOf = (req: FastifyRequest, name: string) => {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
};

export function googleRoutes(app: FastifyInstance, cfg: GoogleConfig | undefined, jwtSecret: string) {
  if (!cfg) return;
  const base = (req: FastifyRequest) => (cfg.publicUrl ?? `${req.protocol}://${req.hostname}`).replace(/\/+$/, '');
  const redirectUri = (req: FastifyRequest) => `${base(req)}/v1/auth/google/callback`;
  const cookie = (req: FastifyRequest, value: string, maxAge: number) =>
    `${COOKIE}=${value}; HttpOnly; Path=/v1/auth/google; Max-Age=${maxAge}; SameSite=Lax${base(req).startsWith('https') ? '; Secure' : ''}`;
  const back = (req: FastifyRequest, reply: any, where: string) =>
    reply.header('cache-control', 'no-store').header('set-cookie', cookie(req, '', 0)).redirect(where, 302);
  const fail = (req: FastifyRequest, reply: any, code: string) => back(req, reply, `/?login_error=${code}`);

  app.get('/v1/auth/google/start', async (req, reply) => {
    const state = randomBytes(16).toString('hex'), nonce = randomBytes(16).toString('hex');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: cfg.clientId, redirect_uri: redirectUri(req), response_type: 'code', scope: 'openid email',
      state, nonce, prompt: 'select_account',
    }).toString();
    const proof = jwt.sign({ st: state, n: nonce }, jwtSecret, { algorithm: 'HS256', expiresIn: 600 });
    return reply.header('cache-control', 'no-store').header('set-cookie', cookie(req, proof, 600)).redirect(url.toString(), 302);
  });

  app.get('/v1/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.error) return fail(req, reply, 'cancelled');
    let proof: any;
    try { proof = jwt.verify(cookieOf(req, COOKIE), jwtSecret, { algorithms: ['HS256'] }); } catch { return fail(req, reply, 'failed'); }
    if (typeof q.state !== 'string' || typeof q.code !== 'string' || !same(q.state, String(proof.st))) return fail(req, reply, 'failed');

    let who: GoogleIdentity;
    try { who = await (cfg.exchange ?? ((c, r) => googleExchange(cfg, c, r)))(q.code, redirectUri(req)); }
    catch (e) { req.log.warn({ err: (e as Error).message }, 'google sign in failed'); return fail(req, reply, 'failed'); }

    const now = Date.now() / 1000;
    const issuerOk = who.iss === 'https://accounts.google.com' || who.iss === 'accounts.google.com';
    if (!issuerOk || who.aud !== cfg.clientId || !(typeof who.exp === 'number' && who.exp > now) || typeof who.nonce !== 'string' || !same(who.nonce, String(proof.n))) return fail(req, reply, 'failed');
    if (typeof who.email !== 'string' || who.email_verified !== true) return fail(req, reply, 'unverified');

    const email = who.email.trim().toLowerCase();
    const user = await withTenant({ tenantId: cfg.tenantId, userId: SYSTEM_USER, actorType: 'system', requestId: req.id }, async (db) => {
      const u = (await db.query(`SELECT id, status FROM app_user WHERE lower(email) = $1 AND deleted_at IS NULL`, [email])).rows[0];
      if (!u || u.status === 'disabled') return u ? 'disabled' as const : undefined;
      await db.query(`UPDATE app_user SET last_login_at = now(), status = CASE WHEN status = 'invited' THEN 'active' ELSE status END WHERE id = $1`, [u.id]);
      return u.id as string;
    });
    if (!user) return fail(req, reply, 'not_invited');
    if (user === 'disabled') return fail(req, reply, 'disabled');

    const token = signToken(jwtSecret, { tenantId: cfg.tenantId, userId: user }, 12 * 3600);
    return back(req, reply, `/#token=${token}`);
  });
}
