// Shared helpers for the operations API.
import { randomBytes } from 'node:crypto';

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...headers },
});
export const fail = (status, code, message) => json({ error: { code, message } }, status);
export const notFound = () => fail(404, 'not_found', 'Not found.');

export class Invalid extends Error { constructor(m) { super(m); this.invalid = true; } }
export class Forbidden extends Error { constructor(stepUp = false) { super(stepUp ? 'step_up' : 'forbidden'); this.status = 403; this.stepUp = stepUp; } }

export const newId = prefix => `${prefix}_${randomBytes(9).toString('base64url')}`;
export const iso = ms => new Date(ms).toISOString();

export function text(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new Invalid(`${field} is required`); return ''; }
  if (typeof v !== 'string') throw new Invalid(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new Invalid(`${field} is too long (max ${max})`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) throw new Invalid(`${field} has invalid characters`);
  if (required && !t) throw new Invalid(`${field} is required`);
  return t;
}
export function oneOf(v, field, list, fallback) {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new Invalid(`${field} is required`); }
  if (!list.includes(v)) throw new Invalid(`${field} must be one of: ${list.join(', ')}`);
  return v;
}
export function date(v, field) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Invalid(`${field} must be a date (YYYY-MM-DD)`);
  return v;
}
export function count(v, field, max = 100000) {
  if (v === undefined || v === null || v === '') return null; // unknown stays unknown, never zero
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Invalid(`${field} must be a whole number`);
  return n;
}
export function url(v, field, { required = true } = {}) {
  const t = text(v, field, 500, { required });
  if (!t) return '';
  let u; try { u = new URL(t); } catch { throw new Invalid(`${field} must be a link`); }
  if (u.protocol !== 'https:') throw new Invalid(`${field} must start with https://`);
  return u.toString();
}
export const maskEmail = e => {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
};

// Postgres drivers differ in how they return timestamps and big integers; normalize to plain JSON.
const TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:?\d{2})?|Z)$/;
export function row(r) {
  if (!r) return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (typeof v === 'string' && TS.test(v)) out[k] = new Date(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00')).toISOString();
    else if (typeof v === 'bigint') out[k] = Number(v);
    else out[k] = v;
  }
  return out;
}
export const rows = list => list.map(row);
export const asJson = v => JSON.stringify(v ?? null);
