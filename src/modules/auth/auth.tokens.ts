import jwt, { type SignOptions } from 'jsonwebtoken';
import { getEnv } from '../../config/env.js';
import type { Role } from '../users/users.types.js';

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  permissions: string[];
  type: 'access';
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
  jti: string;
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  const env = getEnv();
  const opts: SignOptions = {
    expiresIn: env.JWT_ACCESS_EXPIRES_IN as SignOptions['expiresIn'],
    issuer: 'muniback',
    audience: 'munifront',
  };
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_ACCESS_SECRET, opts);
}

export function signRefreshToken(payload: Omit<RefreshTokenPayload, 'type'>): string {
  const env = getEnv();
  const opts: SignOptions = {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
    issuer: 'muniback',
    audience: 'munifront',
  };
  return jwt.sign({ ...payload, type: 'refresh' }, env.JWT_REFRESH_SECRET, opts);
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    issuer: 'muniback',
    audience: 'munifront',
  }) as jwt.JwtPayload;
  if (decoded.type !== 'access' || !decoded.sub) {
    throw new Error('Invalid token type');
  }
  return {
    sub: decoded.sub,
    role: decoded.role as Role,
    permissions: (decoded.permissions as string[]) ?? [],
    type: 'access',
  };
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  const env = getEnv();
  const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
    issuer: 'muniback',
    audience: 'munifront',
  }) as jwt.JwtPayload;
  if (decoded.type !== 'refresh' || !decoded.sub || !decoded.jti) {
    throw new Error('Invalid token type');
  }
  return {
    sub: decoded.sub,
    jti: decoded.jti,
    type: 'refresh',
  };
}

export function refreshTokenExpiryMs(): number {
  const env = getEnv();
  // Best-effort parse: supports strings like "15m", "7d", "1h"
  // We only need ms to set cookie maxAge, so we mirror sign-time logic.
  const value = env.JWT_REFRESH_EXPIRES_IN.trim();
  const match = value.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!match) {
    return 7 * 24 * 60 * 60 * 1000;
  }
  const num = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 'ms':
      return num;
    case 's':
      return num * 1000;
    case 'm':
      return num * 60 * 1000;
    case 'h':
      return num * 60 * 60 * 1000;
    case 'd':
      return num * 24 * 60 * 60 * 1000;
    default:
      return 7 * 24 * 60 * 60 * 1000;
  }
}
