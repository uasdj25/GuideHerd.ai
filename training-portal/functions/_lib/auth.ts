/**
 * auth.ts — session and access helpers for GuideHerd Academy
 *
 * Session cookie: gh_session
 * Format: base64url(userId|issuedAt) + "." + hmac
 * HMAC: HMAC-SHA256(SESSION_SECRET, base64url(userId|issuedAt))
 *
 * Production behaviour:
 *   - Returns null / unauthenticated if cookie is missing or invalid.
 *   - Mock access is only granted when ALLOW_MOCK_ACCESS === "true" AND
 *     the STRIPE_SECRET_KEY is absent or empty (i.e. a local dev environment).
 *     If a real Stripe key is present, mock access is refused even if the
 *     flag is set, to prevent accidental exposure in a staging deployment.
 */

import type { Env, SessionUser } from './types.js';
import { findUserById, hasActiveEntitlement, getActiveSubscription } from './db.js';
import { jsonError } from './types.js';

const COOKIE_NAME = 'gh_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Session encoding ──────────────────────────────────────────────────────────

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlEncode(str: string): string {
  return b64url(new TextEncoder().encode(str));
}

function b64urlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4;
  const base64 = pad ? padded + '='.repeat(4 - pad) : padded;
  return atob(base64);
}

async function hmac(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return b64url(sig);
}

async function verifyHmac(secret: string, message: string, expected: string): Promise<boolean> {
  const actual = await hmac(secret, message);
  // Constant-time comparison
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ── Session cookie creation ───────────────────────────────────────────────────

export async function createSessionCookie(
  userId: string,
  secret: string,
): Promise<string> {
  const payload = b64urlEncode(`${userId}|${Date.now()}`);
  const sig = await hmac(secret, payload);
  const value = `${payload}.${sig}`;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

// ── Session cookie parsing ────────────────────────────────────────────────────

async function parseSessionCookie(
  cookieHeader: string | null,
  secret: string,
): Promise<{ userId: string } | null> {
  if (!cookieHeader) return null;

  const cookies = Object.fromEntries(
    cookieHeader.split(';').map(c => {
      const [k, ...rest] = c.trim().split('=');
      return [k.trim(), rest.join('=')];
    }),
  );

  const raw = cookies[COOKIE_NAME];
  if (!raw) return null;

  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payload = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);

  const valid = await verifyHmac(secret, payload, sig);
  if (!valid) return null;

  let decoded: string;
  try {
    decoded = b64urlDecode(payload);
  } catch {
    return null;
  }

  const [userId, issuedAtStr] = decoded.split('|');
  if (!userId || !issuedAtStr) return null;

  const issuedAt = parseInt(issuedAtStr, 10);
  if (isNaN(issuedAt) || Date.now() - issuedAt > SESSION_TTL_MS) return null;

  return { userId };
}

// ── Mock access guard ─────────────────────────────────────────────────────────

function isMockAllowed(env: Env): boolean {
  if (env.ALLOW_MOCK_ACCESS !== 'true') return false;
  // Refuse mock if a real Stripe key is present — prevents accidental staging exposure
  if (env.STRIPE_SECRET_KEY && env.STRIPE_SECRET_KEY.startsWith('sk_live_')) return false;
  return true;
}

// ── Public auth helpers ───────────────────────────────────────────────────────

/**
 * Returns the session user, or null if not authenticated.
 * Never throws — always safe to call.
 */
export async function getCurrentUser(
  request: Request,
  env: Env,
): Promise<SessionUser | null> {
  if (isMockAllowed(env)) {
    // Local dev mock — never reaches production
    return { id: 'mock-dev-user', email: 'dev@localhost', name: 'Dev User' };
  }

  const session = await parseSessionCookie(
    request.headers.get('Cookie'),
    env.SESSION_SECRET,
  );
  if (!session) return null;

  const user = await findUserById(env.DB, session.userId);
  if (!user) return null;

  return { id: user.id, email: user.email, name: user.name };
}

/**
 * Returns the session user or a 401 Response.
 */
export async function requireUser(
  request: Request,
  env: Env,
): Promise<SessionUser | Response> {
  const user = await getCurrentUser(request, env);
  if (!user) return jsonError('Authentication required', 401);
  return user;
}

/**
 * Returns true if userId has an active 'academy' entitlement.
 */
export async function hasActiveSubscription(
  userId: string,
  env: Env,
): Promise<boolean> {
  if (isMockAllowed(env)) return true;
  const { active } = await hasActiveEntitlement(env.DB, userId, 'academy');
  return active;
}

/**
 * Returns access info for /api/access responses.
 */
export async function getAccessInfo(
  request: Request,
  env: Env,
): Promise<{
  authenticated: boolean;
  hasAccess: boolean;
  plan: string | null;
  subscriptionStatus: string | null;
}> {
  if (isMockAllowed(env)) {
    return { authenticated: true, hasAccess: true, plan: 'academy_monthly', subscriptionStatus: 'active' };
  }

  const user = await getCurrentUser(request, env);
  if (!user) {
    return { authenticated: false, hasAccess: false, plan: null, subscriptionStatus: null };
  }

  const { active } = await hasActiveEntitlement(env.DB, user.id, 'academy');
  if (!active) {
    return { authenticated: true, hasAccess: false, plan: null, subscriptionStatus: null };
  }

  const sub = await getActiveSubscription(env.DB, user.id);
  return {
    authenticated: true,
    hasAccess: true,
    plan: sub?.plan_key ?? null,
    subscriptionStatus: sub?.status ?? null,
  };
}

/**
 * Requires an authenticated user with an active subscription.
 * Returns the user or a 401/403 Response.
 */
export async function requireActiveSubscription(
  request: Request,
  env: Env,
): Promise<SessionUser | Response> {
  const userOrResponse = await requireUser(request, env);
  if (userOrResponse instanceof Response) return userOrResponse;

  const access = await hasActiveSubscription(userOrResponse.id, env);
  if (!access) return jsonError('Active subscription required', 403);

  return userOrResponse;
}
