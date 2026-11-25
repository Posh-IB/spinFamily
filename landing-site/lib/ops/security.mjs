// SpinFamily Pilot Operations: authentication primitives.
// Invite-only, passwordless email sign-in links plus server-side sessions.
// Founder accounts add a time-based authenticator code (TOTP, RFC 6238).
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-sf_ops';
export const LINK_TTL_MS = 15 * 60 * 1000;          // sign-in link: 15 minutes, single use
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000;   // signed out after 8 hours idle
export const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000; // and after 7 days regardless
export const MFA_PENDING_MS = 10 * 60 * 1000;        // time allowed to enter the authenticator code

export const sha256 = v => createHash('sha256').update(String(v)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export const newId = prefix => `${prefix}_${randomBytes(9).toString('base64url')}`;

const EMAIL = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i;
export function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (!e || e.length > 120 || e.includes('..') || !EMAIL.test(e)) return null;
  return e;
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(value, maxAgeSeconds) {
  // __Host- prefix: Secure, Path=/, no Domain. Strict same-site blocks cross-site requests.
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
export const clearCookie = () => sessionCookie('', 0);

// ---- TOTP (RFC 6238, SHA-1, 30 s, 6 digits): works with Google Authenticator, 1Password, Authy ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(randomBytes(20));
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
// Returns the matched time step (to block reuse) or null. Accepts one step of clock drift.
export function verifyTotp(secret, code, nowMs, lastStep = -1) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = Math.floor(nowMs / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s > lastStep && safeEqual(totpAt(secret, s), code)) return s;
  }
  return null;
}
export function otpauthUri(secret, email) {
  const label = encodeURIComponent(`SpinFamily Ops:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('SpinFamily Ops')}&algorithm=SHA1&digits=6&period=30`;
}
