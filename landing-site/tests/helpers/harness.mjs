// Test harness: a real PostgreSQL 17 server (embedded-postgres) with a multi-connection pool, so
// locking and transactions are tested the way they run on Netlify Database. Synthetic records only.
// Set OPS_TEST_DATABASE_URL to run against another Postgres instead (it must be a throwaway database).
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { makeDb } from '../../lib/ops/db.mjs';
import { handle, FOUNDER_EMAIL } from '../../lib/ops/core.mjs';
import { memoryFiles } from '../../lib/ops/files.mjs';
import { totpAt, SESSION_COOKIE } from '../../lib/ops/security.mjs';

export const ORIGIN = 'https://spinfamilyapp.com';
export const COORD = 'coordinator@example.com';
export const BOOTSTRAP = 'test-bootstrap-code';
export const RECOVERY = 'test-recovery-code';
const MIGRATIONS = new URL('../../netlify/database/migrations/', import.meta.url);

export async function startDatabase() {
  let server = null, dir = null, url = process.env.OPS_TEST_DATABASE_URL;
  if (!url) {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    // Test files run in parallel, each with its own server on a random port; retry on a clash.
    for (let attempt = 1; ; attempt++) {
      // Let embedded-postgres create the directory itself: when tests run as root it hands the
      // directory to an unprivileged user, which a pre-created 0700 temp dir would block.
      dir = join(tmpdir(), `sf-ops-pg-${randomBytes(6).toString('hex')}`);
      const port = 20000 + Math.floor(Math.random() * 20000);
      server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'test', port, persistent: false, onLog: () => {}, onError: () => {} });
      try {
        await server.initialise();
        await server.start();
        url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
        break;
      } catch (e) {
        await server.stop().catch(() => {}); rmSync(dir, { recursive: true, force: true });
        if (attempt >= 3) throw e;
      }
    }
  }
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  // An idle connection closed while the server shuts down must not crash the test process.
  pool.on('error', () => {});
  // Apply migrations in order, exactly as Netlify does on deploy.
  for (const f of readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort())
    await pool.query(readFileSync(new URL(f, MIGRATIONS), 'utf8'));
  const db = makeDb(pool);
  return {
    db, pool, url,
    async reset() {
      const t = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'orgs'`)).rows.map(r => `"${r.tablename}"`);
      await pool.query(`TRUNCATE ${t.join(', ')} RESTART IDENTITY CASCADE`);
    },
    async stop() { await pool.end().catch(() => {}); if (server) await server.stop().catch(() => {}); if (dir) rmSync(dir, { recursive: true, force: true }); },
  };
}

// Deterministic interleaving: a test arms a named pause point; the request that reaches it waits
// until the test releases it. `waitForLockWait` polls Postgres until another connection is blocked
// on a lock, which proves the second request is queued behind the first rather than racing it.
export function barriers() {
  const armed = new Map();
  const hook = async name => {
    const b = armed.get(name);
    if (!b || b.used) return;
    b.used = true;
    b.reached();
    await b.release;
  };
  const arm = name => {
    let reached, release;
    const reachedP = new Promise(r => { reached = r; });
    const releaseP = new Promise(r => { release = r; });
    armed.set(name, { reached, release: releaseP, used: false });
    return { reached: reachedP, release };
  };
  return { hook, arm };
}
export async function waitForLockWait(pool, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`)).rows[0].n;
    if (n > 0) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('no connection ever waited on a lock');
}

export function world(db, { deployContext = 'production', netlifyUser = null, secrets = { bootstrap: BOOTSTRAP, recovery: RECOVERY }, features = ['uploads', 'research'], hook } = {}) {
  const mail = [];
  let clock = Date.parse('2026-11-24T15:00:00Z');
  const deps = { sql: db.sql, tx: db.tx, files: memoryFiles(), orgId: 'spinfamily', now: () => clock, origin: ORIGIN, deployContext, netlifyUser, mailbox: 'hello@spinfamilyapp.com', secrets, features: new Set(features), hook, sendMail: async m => { mail.push(m); return { accepted: [m.to.address] }; } };
  const call = async (method, path, body, { cookie, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = `${SESSION_COOKIE}=${cookie}`;
    if (method !== 'GET') { h['content-type'] ??= 'application/json'; h['x-sf-ops'] ??= '1'; h.origin ??= ORIGIN; }
    const res = await handle(new Request(`${ORIGIN}/operations/api/${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }), deps);
    const sid = res.headers.get('set-cookie')?.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : null, sid, headers: res.headers, res };
  };
  const tokenFrom = m => m.text.match(/#signin=([\w-]+)/)[1];
  const requestLink = async email => { const before = mail.length; await call('POST', 'auth/request', { email }); assert.equal(mail.length, before + 1, `link sent to ${email}`); return tokenFrom(mail.at(-1)); };
  const signIn = async email => { const r = await call('POST', 'auth/verify', { token: await requestLink(email) }); assert.equal(r.status, 200); return r.sid; };
  const code = secret => totpAt(secret, Math.floor(clock / 30000));
  const setup = async (sid, founder) => {
    const s = await call('POST', 'auth/authenticator/setup', founder ? { enrollmentCode: BOOTSTRAP } : {}, { cookie: sid });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    return s.body;
  };
  const enroll = async (sid, founder) => {
    const s = await setup(sid, founder);
    const c = await call('POST', 'auth/authenticator/confirm', { setupId: s.setupId, code: code(s.secret) }, { cookie: sid });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    return s.secret;
  };
  const ready = async (email, founder = email === FOUNDER_EMAIL) => { const sid = await signIn(email); const secret = await enroll(sid, founder); return { sid, secret }; };
  const tick = ms => { clock += ms; };
  return { mail, deps, call, requestLink, signIn, setup, enroll, ready, code, tick, get clock() { return clock; } };
}

export async function team(w) {
  const f = await w.ready(FOUNDER_EMAIL);
  const inv = await w.call('POST', 'team/invite', { email: COORD, name: 'Test Coordinator', role: 'coordinator' }, { cookie: f.sid });
  assert.equal(inv.status, 201);
  w.tick(31000);
  const c = await w.ready(COORD);
  return { sid: f.sid, secret: f.secret, csid: c.sid, csecret: c.secret, coordId: inv.body.member.id };
}

// A participant who registered through the form and was reviewed as real (not a test).
export const FORM = { 'form-name': 'pilot', source: 'direct', company: '', first_name: 'Juliet', email: 'Juliet@Example.com', children_under_10: '2', heard_from: 'An event', consent: 'yes' };
export async function reviewedParticipant(w, sid, { firstName, email, assignedTo = null }) {
  const { ingestPilotSubmission } = await import('../../lib/ops/records.mjs');
  await ingestPilotSubmission(w.deps, { ...FORM, first_name: firstName, email }, new Date(w.clock).toISOString());
  let p = (await w.call('GET', 'participants', undefined, { cookie: sid })).body.participants.find(x => x.email === email);
  p = (await w.call('PATCH', `participants/${p.id}`, { isTest: false, ...(assignedTo ? { assignedTo } : {}), version: p.version }, { cookie: sid })).body.participant;
  return p;
}

// Approve the seeded questionnaire and the participation notice (founder), ready for survey links.
export async function researchReady(w, sid, csid) {
  const overview = (await w.call('GET', 'research', undefined, { cookie: csid })).body;
  const draft = overview.surveys.find(s => s.status === 'draft');
  assert.equal((await w.call('POST', 'research/notice/approve', { version: overview.notice.current.version }, { cookie: sid })).status, 200);
  assert.equal((await w.call('POST', `research/surveys/${draft.id}/submit`, {}, { cookie: csid })).status, 200);
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey' && a.status === 'pending');
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 200);
  return { survey: draft, notice: overview.notice.current };
}
export async function surveyLink(w, cookie, surveyId, participantId, extra = {}) {
  const r = await w.call('POST', 'research/invites', { surveyId, participantId, ...extra }, { cookie });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.link.match(/#t=([\w-]+)/)[1];
}
