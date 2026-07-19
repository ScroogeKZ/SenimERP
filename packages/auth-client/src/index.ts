import jwt from 'jsonwebtoken';
import { SsoJwtPayload } from '@senimerp/types';

// Shared secret key for SSO verification between CRM, ERP and the Auth Service
const SSO_SECRET = process.env.JWT_SSO_SECRET || 'senim-sso-secret-key-2026';

/**
 * Verifies a JWT token issued by the SSO Auth Service.
 * @param token The JWT string to verify.
 * @returns The decoded SSO payload.
 */
export function verifySsoToken(token: string): SsoJwtPayload {
  try {
    return jwt.verify(token, SSO_SECRET) as SsoJwtPayload;
  } catch (error) {
    throw new Error(`Invalid or expired SSO token: ${(error as Error).message}`);
  }
}

/**
 * Utility to generate an SSO token (mainly used by auth-service and mock testing).
 * @param payload SSO payload (excludes automatic fields like iat and exp).
 * @param expiresIn Token expiration string (default: '24h').
 * @returns Signed JWT string.
 */
export function signSsoToken(payload: Omit<SsoJwtPayload, 'iat' | 'exp'>, expiresIn = '24h'): string {
  return jwt.sign(payload, SSO_SECRET, { expiresIn: expiresIn as any });
}
