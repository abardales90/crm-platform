import jwt from 'jsonwebtoken';
import { ApiError } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Identity = { tenantId: string; userId: string };

export function signToken(secret: string, id: Identity, ttlSeconds = 8 * 3600): string {
  return jwt.sign({ tid: id.tenantId, uid: id.userId }, secret, { algorithm: 'HS256', expiresIn: ttlSeconds });
}

export function verifyToken(secret: string, header: string | undefined): Identity {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  if (!m) throw new ApiError(401, 'unauthenticated', 'Missing bearer token');
  let claims: any;
  try {
    claims = jwt.verify(m[1], secret, { algorithms: ['HS256'] });
  } catch {
    throw new ApiError(401, 'unauthenticated', 'Invalid or expired token');
  }
  if (!UUID.test(claims?.tid ?? '') || !UUID.test(claims?.uid ?? '')) {
    throw new ApiError(401, 'unauthenticated', 'Invalid token claims');
  }
  return { tenantId: claims.tid, userId: claims.uid };
}
