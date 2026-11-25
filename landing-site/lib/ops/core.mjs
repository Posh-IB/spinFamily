// SpinFamily Pilot Operations API core (SF-PILOT-OPS-001): routing, sign-in, sessions, team, audit.
// Pure request handler: all I/O comes in through `deps` so it runs the same in tests and on Netlify.
//
// deps = { sql, tx, files, orgId, now, origin, deployContext, netlifyUser, mailbox, secrets, features, sendMail, log, hook }
//   sql   – tagged-template Postgres client (db.mjs); tx(fn) runs fn in one transaction
//   secrets – { bootstrap, recovery } founder one-time codes for THIS deploy context (runtime.secretsFor)
//   features – Set of optional features switched on (runtime.featuresFrom)
//   hook  – tests only: awaited at named pause points so races can be replayed deterministically
//   files – { put(key, bytes, meta), get(key) } file storage (Netlify Blobs)
import {
  SESSION_COOKIE, LINK_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, MFA_PENDING_MS,
  sha256, newToken, normalizeEmail, parseCookies, sessionCookie, clearCookie,
  newTotpSecret, verifyTotp, otpauthUri, safeEqual,
} from './security.mjs';
import { inTx, barrier } from './db.mjs';
import { enqueue, mailFor, drainOutbox } from './outbox.mjs';
import { ROLES, can, permissionsFor, STEP_UP } from './permissions.mjs';
import { json, fail, notFound, Invalid, Forbidden, newId, iso, text, oneOf, row, rows, asJson } from './util.mjs';
import { recordRoutes } from './records.mjs';
import { docRoutes } from './docs.mjs';
import { approvalRoutes } from './approvals.mjs';
import { contentRoutes } from './content.mjs';
import { researchRoutes, publicSurveyRoutes } from './research.mjs';

export const ORG_FOUNDERS = { spinfamily: 'dion@spinfamilyapp.com' };
export const FOUNDER_EMAIL = ORG_FOUNDERS.spinfamily;
export const PRODUCTION_ORIGIN = 'https://spinfamilyapp.com';
const MAX_BODY = 32 * 1024;
const MAX_UPLOAD_BODY = 6 * 1024 * 1024;

// ---------- Audit (ids and action names only, never names or emails) ----------
// Outside a transaction a failed audit write is logged and the request carries on. Inside one it
// fails the transaction, so a decision and its audit record are saved together or not at all.
export async function audit(deps, actor, action, target = null, extra = {}) {
  const write = () => deps.sql`INSERT INTO audit_events (org_id, at, actor, action, target, extra) VALUES (${deps.orgId}, ${iso(deps.now())}, ${actor || 'anonymous'}, ${action}, ${target}, ${asJson(extra)}::jsonb)`;
  if (deps.sql.inTx) { await write(); return; }
  try { await write(); }
  catch (e) { deps.log?.({ component: 'ops-audit', state: 'write_failed', action, code: e?.code || null }); }
}

// ---------- Members ----------
function fixMember(r) {
  const m = row(r);
  for (const k of ['totp_last_step', 'sessions_valid_after', 'auth_generation']) m[k] = Number(m[k]);
  m.mfa_failures = Array.isArray(m.mfa_failures) ? m.mfa_failures.map(Number) : [];
  m.link_requests = Array.isArray(m.link_requests) ? m.link_requests.map(Number) : [];
  return m;
}
async function memberByEmail(deps, email, { lock = false } = {}) {
  const r = lock
    ? await deps.sql`SELECT m.*, ms.role, ms.title, ms.status, ms.invited_by FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.email = ${email} FOR UPDATE OF m, ms`
    : await deps.sql`SELECT m.*, ms.role, ms.title, ms.status, ms.invited_by FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.email = ${email}`;
  return r[0] ? fixMember(r[0]) : null;
}
export async function memberById(deps, id, { lock = false } = {}) {
  const r = lock
    ? await deps.sql`SELECT m.*, ms.role, ms.title, ms.status, ms.invited_by FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.id = ${id} FOR UPDATE OF m, ms`
    : await deps.sql`SELECT m.*, ms.role, ms.title, ms.status, ms.invited_by FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.id = ${id}`;
  return r[0] ? fixMember(r[0]) : null;
}
export async function orgMembers(deps) {
  const r = await deps.sql`SELECT m.*, ms.role, ms.title, ms.status, ms.invited_by FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} ORDER BY ms.created_at`;
  return r.map(fixMember);
}

export function publicMember(m) {
  return { id: m.id, name: m.name, email: m.email, title: m.title, role: m.role, roleLabel: ROLES[m.role]?.label, riccTitle: ROLES[m.role]?.riccTitle, status: m.status, createdAt: m.created_at, lastSignInAt: m.last_sign_in_at || null, mfaEnabled: !!m.totp_enabled };
}

async function ensureFounder(deps) {
  const email = ORG_FOUNDERS[deps.orgId];
  if (!email) return null;
  const existing = await memberByEmail(deps, email);
  if (existing) return existing;
  await deps.sql`INSERT INTO members (id, email, name) VALUES (${newId('m')}, ${email}, ${'Dion Thornton'}) ON CONFLICT (email) DO NOTHING`;
  const real = (await deps.sql`SELECT id FROM members WHERE email = ${email}`)[0].id;
  await deps.sql`INSERT INTO memberships (org_id, member_id, role, title, status, invited_by) VALUES (${deps.orgId}, ${real}, 'founder', 'Founder', 'invited', 'bootstrap') ON CONFLICT DO NOTHING`;
  return memberByEmail(deps, email);
}

// R2-01: the one move every access change makes, inside the transaction that holds the member's lock.
// Bumping the generation kills every link and session issued before it; the explicit cancel and
// delete just clean up. Returns the new generation.
async function rotateAccess(t, memberId, { keepSession = null } = {}) {
  const gen = Number((await t.sql`UPDATE members SET auth_generation = auth_generation + 1, sessions_valid_after = ${t.now()} WHERE id = ${memberId} RETURNING auth_generation`)[0].auth_generation);
  await t.sql`UPDATE login_links SET used_at = ${t.now()} WHERE member_id = ${memberId} AND used_at IS NULL`;
  if (keepSession) {
    await t.sql`DELETE FROM sessions WHERE member_id = ${memberId} AND sid_hash <> ${keepSession}`;
    await t.sql`UPDATE sessions SET auth_generation = ${gen} WHERE sid_hash = ${keepSession}`;
  } else await t.sql`DELETE FROM sessions WHERE member_id = ${memberId}`;
  return gen;
}

const secretOk = (expected, given) => !!expected && typeof given === 'string' && given.length <= 200 && safeEqual(sha256(given.trim()), sha256(expected.trim()));
const MFA_WINDOW_MS = 15 * 60 * 1000, MEMBER_MFA_LIMIT = 10, SESSION_MFA_LIMIT = 5, SETUP_TTL_MS = 15 * 60 * 1000;
// Wrong codes are counted per person across every session, not just per session.
async function recordFactorFailure(t, m, sidHash) {
  const now = t.now();
  const recent = [...m.mfa_failures.filter(x => x > now - MFA_WINDOW_MS), now];
  await t.sql`UPDATE members SET mfa_failures = ${asJson(recent)}::jsonb WHERE id = ${m.id}`;
  let sessionFailures = 0;
  if (sidHash) sessionFailures = Number((await t.sql`UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE sid_hash = ${sidHash} RETURNING mfa_failures`)[0]?.mfa_failures || 0);
  return { memberFailures: recent.length, sessionFailures };
}
const factorLocked = (m, now) => m.mfa_failures.filter(x => x > now - MFA_WINDOW_MS).length >= MEMBER_MFA_LIMIT;

// ---------- Sessions ----------
async function readSessionRow(sql, hash, lock = false) {
  const s = (lock
    ? await sql`SELECT sid_hash, member_id, org_id, created_at, last_seen, expires_at, mfa, mfa_failures, via, auth_generation FROM sessions WHERE sid_hash = ${hash} FOR UPDATE`
    : await sql`SELECT sid_hash, member_id, org_id, created_at, last_seen, expires_at, mfa, mfa_failures, via, auth_generation FROM sessions WHERE sid_hash = ${hash}`)[0];
  if (!s) return null;
  for (const k of ['created_at', 'last_seen', 'expires_at', 'mfa_failures']) s[k] = Number(s[k]);
  s.auth_generation = s.auth_generation === null ? null : Number(s.auth_generation);
  return s;
}
function sessionUsable(s, member, now, orgId) {
  if (!s || s.org_id !== orgId) return false;
  if (now > s.expires_at || now - s.last_seen > SESSION_IDLE_MS || (s.mfa === 'pending' && now - s.created_at > MFA_PENDING_MS)) return false;
  return !!member && member.status === 'active' && s.auth_generation !== null && s.auth_generation === member.auth_generation;
}
async function loadSession(req, deps) {
  const sid = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!sid || sid.length > 100) return null;
  const hash = sha256(sid);
  const s = await readSessionRow(deps.sql, hash);
  if (!s) return null;
  if (s.org_id !== deps.orgId) return null;
  const member = await memberById(deps, s.member_id);
  const now = deps.now();
  if (!sessionUsable(s, member, now, deps.orgId)) { await deps.sql`DELETE FROM sessions WHERE sid_hash = ${hash}`; return null; }
  if (now - s.last_seen > 60000) await deps.sql`UPDATE sessions SET last_seen = ${now} WHERE sid_hash = ${hash}`;
  return { hash, session: s, member };
}
// Inside a transaction: lock the member, then the session, and re-check that the session still
// belongs to the member's current generation. Lock order is always member -> session -> links.
async function lockContext(t, ctx) {
  const member = await memberById(t, ctx.member.id, { lock: true });
  const session = await readSessionRow(t.sql, ctx.hash, true);
  if (!sessionUsable(session, member, t.now(), t.orgId)) return null;
  return { member, session, hash: ctx.hash };
}

async function startSession(t, member, via) {
  const sid = newToken(), now = t.now();
  const mfa = member.totp_enabled ? 'pending' : 'none';
  await t.sql`INSERT INTO sessions (sid_hash, member_id, org_id, created_at, last_seen, expires_at, mfa, via, auth_generation) VALUES (${sha256(sid)}, ${member.id}, ${t.orgId}, ${now}, ${now}, ${now + SESSION_MAX_MS}, ${mfa}, ${via}, ${member.auth_generation})`;
  return { cookie: sessionCookie(sid, Math.floor(SESSION_MAX_MS / 1000)), mfa: mfa === 'pending' ? 'pending' : false };
}

async function activate(t, member) {
  await t.sql`UPDATE memberships SET status = 'active' WHERE org_id = ${t.orgId} AND member_id = ${member.id} AND status = 'invited'`;
  await t.sql`UPDATE members SET last_sign_in_at = ${iso(t.now())} WHERE id = ${member.id}`;
  return { ...member, status: 'active' };
}

// ---------- Email ----------
// Sign-in links go out directly, right after the transaction that issued them commits.
// Everything else goes through the notifications outbox (outbox.mjs).
export async function sendTo(deps, member, subject, body) {
  await deps.sendMail(mailFor(deps, member, subject, body));
}

// ---------- Routing ----------
export async function handle(req, deps) {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/operations\/api\/?/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  // Notifications written by a committed change are sent once the response is ready (R2-04).
  const afterWrite = async res => {
    if (method !== 'GET' && res.status < 500 && deps.tx) {
      try { await drainOutbox(deps); } catch (e) { deps.log?.({ component: 'ops-outbox', state: 'drain_failed', code: e?.code || null }); }
    }
    return res;
  };

  try {
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      // CSRF defence: strict same-site cookie + same origin + custom header + JSON only.
      const o = req.headers.get('origin');
      if (o && o !== deps.origin) return fail(403, 'bad_origin', 'Request blocked.');
      if (req.headers.get('x-sf-ops') !== '1') return fail(403, 'missing_header', 'Request blocked.');
      if (!String(req.headers.get('content-type') || '').startsWith('application/json')) return fail(415, 'json_only', 'Send JSON.');
      const limit = path === 'resources/upload' ? MAX_UPLOAD_BODY : MAX_BODY;
      if (Number(req.headers.get('content-length') || 0) > limit) return fail(413, 'too_large', 'That file or request is too large.');
      const raw = await req.text();
      if (raw.length > limit) return fail(413, 'too_large', 'That file or request is too large.');
      try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, 'bad_json', 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json', 'Invalid JSON.');
    }

    if (parts[0] === 'auth') { const r = await authRoutes(parts.slice(1), method, body, req, deps); if (r) return await afterWrite(r); }
    if (parts[0] === 'public') { const r = await publicSurveyRoutes(parts.slice(1), method, body, deps); if (r) return r; }

    const ctx = await loadSession(req, deps);
    if (!ctx) return fail(401, 'signed_out', 'Please sign in.');
    if (ctx.session.mfa === 'pending') return fail(401, 'mfa_required', 'Enter your authenticator code.');
    // Parent details are behind a second factor for everyone (IR-07): no data until the authenticator is set up and used.
    if (ctx.session.mfa !== 'verified') return fail(403, 'authenticator_required', 'Set up your authenticator app under Team & security to continue.');
    const { member } = ctx;
    const verified = ctx.session.mfa === 'verified';
    const env = {
      ...deps, member, session: ctx.session, query: Object.fromEntries(u.searchParams),
      need: action => { if (!can(member, action)) throw new Forbidden(); if (STEP_UP.has(action) && !verified) throw new Forbidden(true); },
      has: action => can(member, action) && (!STEP_UP.has(action) || verified),
      // `this` is whichever env copy is calling, so inside inTx() the audit row joins the transaction.
      audit(action, target, extra) { return audit(this, member.id, action, target, extra); },
    };
    const sub = parts.slice(1);
    const dispatch = async e => {
      switch (parts[0]) {
        case 'team': return teamRoutes(sub, method, body, e);
        case 'audit': if (method === 'GET') { e.need('audit.view'); return json({ audit: rows(await e.sql`SELECT at, actor, action, target FROM audit_events WHERE org_id = ${e.orgId} ORDER BY id DESC LIMIT 200`) }); } return null;
        case 'resources': return docRoutes(sub, method, body, e);
        case 'approvals': return approvalRoutes(sub, method, body, e);
        case 'content': return contentRoutes(sub, method, body, e);
        case 'research': return researchRoutes(sub, method, body, e);
        default: return recordRoutes(parts, method, body, e);
      }
    };
    // Authority boundary (third review, item 4): reads use the authority checked when the request
    // started. Every write runs in one transaction that first re-checks, under a share lock on the
    // member and membership, that the person is still active and the session is still current. A
    // revocation either waits for an in-flight write to commit, or the write sees it and is refused.
    const res = method === 'GET' ? await dispatch(env) : await inTx(env, async t => {
      const cur = (await t.sql`SELECT m.auth_generation, ms.status FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${t.orgId} WHERE m.id = ${member.id} FOR SHARE OF m, ms`)[0];
      const live = (await t.sql`SELECT auth_generation FROM sessions WHERE sid_hash = ${ctx.hash}`)[0];
      if (!cur || cur.status !== 'active' || !live || Number(cur.auth_generation) !== Number(live.auth_generation)) { const e = new Error('revoked'); e.revoked = true; throw e; }
      await barrier(t, 'write.authority.checked');
      return dispatch(t);
    });
    return res ? await afterWrite(res) : notFound();
  } catch (e) {
    if (e.revoked) return fail(401, 'signed_out', 'Your access changed. Please sign in again.');
    if (e.invalid) return fail(400, 'invalid', e.message);
    if (e.stepUp) return fail(403, 'step_up_required', 'This needs your authenticator code. Set it up or enter it under Team & security.');
    if (e.status === 403) return fail(403, 'forbidden', "You don't have access to that.");
    if (e.stale) return fail(409, 'stale', e.message);
    if (e.conflict) return fail(409, 'conflict', 'Someone changed this while you were editing. Reload to see the latest, then make your change again.');
    if (e.code === '23505') return fail(409, 'duplicate', 'That already exists.');
    // Logs carry the error class and database code only, never values that could contain personal data.
    deps.log?.({ component: 'ops-api', state: 'error', name: e?.name || 'Error', code: e?.code || null, route: parts.slice(0, 2).join('/') });
    return fail(500, 'server_error', 'Something went wrong. Reload and check whether your change was saved before trying again.');
  }
}

// ---------- Auth ----------
const OK_STATUS = ['active', 'invited'];
async function authRoutes(parts, method, body, req, deps) {
  switch (`${method} ${parts.join('/')}`) {
    case 'POST request': {
      // Always the same answer, so the endpoint can't be used to find out who is on the team.
      const generic = json({ ok: true, message: 'If that email belongs to the SpinFamily team, a sign-in link is on its way.' });
      const email = normalizeEmail(body.email);
      if (!email) return generic;
      if (email === ORG_FOUNDERS[deps.orgId]) await ensureFounder(deps);
      const now = deps.now();
      await deps.sql`DELETE FROM login_links WHERE expires_at < ${now - 864e5}`;
      await deps.sql`DELETE FROM sessions WHERE expires_at < ${now}`;
      const token = newToken();
      // R2-01: issue under the member's lock. The address, membership and generation checked here
      // are the ones written on the link; any later access change bumps the generation and kills it.
      const issued = await inTx(deps, async t => {
        await barrier(t, 'link.issue.before_lock');
        const m = await memberByEmail(t, email, { lock: true });
        if (!m || !OK_STATUS.includes(m.status)) { await audit(t, null, 'auth.link_denied'); return null; }
        const recent = m.link_requests.filter(x => x > now - LINK_TTL_MS);
        if (recent.length >= 3) { await audit(t, m.id, 'auth.link_throttled'); return null; }
        await barrier(t, 'link.issue.locked');
        await t.sql`UPDATE members SET link_requests = ${asJson([...recent, now])}::jsonb WHERE id = ${m.id}`;
        await t.sql`INSERT INTO login_links (token_hash, member_id, org_id, expires_at, auth_generation, email) VALUES (${sha256(token)}, ${m.id}, ${deps.orgId}, ${now + LINK_TTL_MS}, ${m.auth_generation}, ${m.email})`;
        return m;
      });
      if (!issued) return generic;
      const link = `${deps.origin}/operations/#signin=${token}`;
      try {
        await sendTo(deps, issued, 'Your SpinFamily Operations sign-in link', `Use this link to sign in to the SpinFamily Pilot Operations workspace:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask to sign in, you can ignore this email; nobody can get in without it.`);
        await audit(deps, issued.id, 'auth.link_sent');
      } catch { await audit(deps, issued.id, 'auth.link_send_failed'); }
      return generic;
    }
    case 'POST verify': {
      const token = typeof body.token === 'string' && body.token.length < 100 ? body.token : '';
      const bad = () => fail(400, 'link_invalid', 'That sign-in link has expired or was already used. Request a new one.');
      if (!token) return bad();
      const hash = sha256(token);
      const peek = (await deps.sql`SELECT member_id FROM login_links WHERE token_hash = ${hash} AND org_id = ${deps.orgId}`)[0];
      if (!peek) { await audit(deps, null, 'auth.link_rejected'); return bad(); }
      // Lock the member first (same order as every access change), then claim the link, then
      // check the link was issued to this address under the current generation.
      const r = await inTx(deps, async t => {
        const m = await memberById(t, peek.member_id, { lock: true });
        await barrier(t, 'link.claim.locked');
        const link = (await t.sql`UPDATE login_links SET used_at = ${t.now()} WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at >= ${t.now()} AND org_id = ${t.orgId} RETURNING member_id, auth_generation, email`)[0];
        if (!link || !m) return null;
        if (link.auth_generation === null || Number(link.auth_generation) !== m.auth_generation || link.email !== m.email || !OK_STATUS.includes(m.status)) return null;
        const active = await activate(t, m);
        const s = await startSession(t, active, 'email-link');
        await audit(t, m.id, 'auth.signed_in', null, { via: 'email-link' });
        return s;
      });
      if (!r) { await audit(deps, null, 'auth.link_rejected'); return bad(); }
      return json({ ok: true, mfa: r.mfa }, 200, { 'set-cookie': r.cookie });
    }
    case 'POST preview': {
      // Preview deploys only: Netlify team login has already verified who this is.
      if (deps.deployContext === 'production' || !deps.netlifyUser?.email) return notFound();
      let email = normalizeEmail(deps.netlifyUser.email);
      // The founder's Netlify login can use a different address from their work email. On previews
      // only, OPS_PREVIEW_FOUNDER_LOGIN (set in Netlify, never in source) maps that login to the founder.
      const founderLogin = normalizeEmail(deps.previewFounderLogin || '');
      if (founderLogin && email === founderLogin) email = ORG_FOUNDERS[deps.orgId];
      if (email === ORG_FOUNDERS[deps.orgId]) await ensureFounder(deps);
      const r = await inTx(deps, async t => {
        const m = email && await memberByEmail(t, email, { lock: true });
        if (!m || !OK_STATUS.includes(m.status)) return null;
        const s = await startSession(t, await activate(t, m), 'netlify-team-preview');
        await audit(t, m.id, 'auth.signed_in', null, { via: 'netlify-team-preview' });
        return s;
      });
      if (!r) return fail(403, 'forbidden', 'Your Netlify account is not on the SpinFamily team list.');
      return json({ ok: true, mfa: r.mfa }, 200, { 'set-cookie': r.cookie });
    }
    case 'POST logout': {
      const ctx = await loadSession(req, deps).catch(() => null);
      const sid = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
      if (sid) await deps.sql`DELETE FROM sessions WHERE sid_hash = ${sha256(sid)}`;
      if (ctx) await audit(deps, ctx.member.id, 'auth.signed_out');
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    }
    case 'GET me': {
      const ctx = await loadSession(req, deps);
      if (!ctx) return fail(401, 'signed_out', 'Please sign in.');
      const { member, session } = ctx;
      const verified = session.mfa === 'verified';
      const org = (await deps.sql`SELECT id, name FROM orgs WHERE id = ${deps.orgId}`)[0];
      const isFounderSetup = member.role === 'founder' && !member.totp_enabled;
      return json({
        member: publicMember(member), org,
        mfa: session.mfa === 'pending' ? 'pending' : verified ? 'verified' : 'none',
        needsAuthenticator: !member.totp_enabled,
        founderEnrollmentCodeRequired: isFounderSetup && !session.via.endsWith('+recovery'),
        founderSecretsMisconfigured: !!deps.secrets?.misconfigured,
        permissions: session.mfa === 'pending' ? [] : permissionsFor(member).filter(a => !STEP_UP.has(a) || verified),
        features: [...(deps.features || [])],
        previewDeploy: deps.deployContext !== 'production',
      });
    }
    case 'POST mfa': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa !== 'pending') return fail(401, 'signed_out', 'Please sign in again.');
      const code = String(body.code || '').slice(0, 12);
      const r = await inTx(deps, async t => {
        const c = await lockContext(t, ctx);
        if (!c || c.session.mfa !== 'pending' || !c.member.totp_enabled) return { signedOut: true };
        const { member: m } = c;
        if (factorLocked(m, t.now())) { await audit(t, m.id, 'auth.mfa_member_locked'); return { locked: true }; }
        await barrier(t, 'mfa.verify.locked');
        // The time step is consumed under the member lock, so one code works once across all sessions.
        const step = verifyTotp(m.totp_secret, code, t.now(), m.totp_last_step);
        if (step === null) {
          const f = await recordFactorFailure(t, m, c.hash);
          if (f.sessionFailures >= SESSION_MFA_LIMIT) { await t.sql`DELETE FROM sessions WHERE sid_hash = ${c.hash}`; await audit(t, m.id, 'auth.mfa_locked'); return { signedOut: true, locked: true }; }
          await audit(t, m.id, 'auth.mfa_failed');
          return { bad: true };
        }
        await t.sql`UPDATE members SET totp_last_step = ${step}, mfa_failures = '[]'::jsonb WHERE id = ${m.id}`;
        await t.sql`UPDATE sessions SET mfa = 'verified' WHERE sid_hash = ${c.hash}`;
        await audit(t, m.id, 'auth.mfa_verified');
        return { ok: true };
      });
      if (r.ok) return json({ ok: true });
      if (r.signedOut) return fail(401, 'signed_out', r.locked ? 'Too many wrong codes. Request a new sign-in link.' : 'Please sign in again.');
      if (r.locked) return fail(429, 'too_many_codes', 'Too many wrong codes for this account. Wait 15 minutes, then try again.');
      return fail(400, 'bad_code', "That code didn't match. Try the newest code in your authenticator app.");
    }
    case 'POST authenticator/setup': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const r = await inTx(deps, async t => {
        const c = await lockContext(t, ctx);
        if (!c || c.session.mfa === 'pending') return { status: 401 };
        const { member: m, session } = c;
        if (m.totp_enabled && session.mfa !== 'verified') return { status: 403, code: 'step_up_required', message: 'Enter your current code first.' };
        if (factorLocked(m, t.now())) return { status: 429, code: 'too_many_codes', message: 'Too many wrong codes for this account. Wait 15 minutes, then try again.' };
        let bootstrapHash = null;
        // The founder's first authenticator needs the one-time bootstrap code from this deploy's own
        // Netlify settings. After a recovery (recover below) the recovery code already proved it.
        if (m.role === 'founder' && !m.totp_enabled && !session.via.endsWith('+recovery')) {
          if (deps.secrets?.misconfigured) return { status: 403, code: 'enrollment_code', message: 'Founder setup is locked: the setup and recovery codes in Netlify must be different.' };
          if ((await t.sql`SELECT 1 FROM secret_uses WHERE org_id = ${t.orgId} AND purpose = 'founder_bootstrap'`)[0]) return { status: 403, code: 'bootstrap_used', message: 'The one-time setup code was already used. Use "Lost your phone?" with the recovery code instead.' };
          if (!secretOk(deps.secrets?.bootstrap, body.enrollmentCode)) {
            await recordFactorFailure(t, m, null);
            await audit(t, m.id, 'auth.enrollment_code_rejected');
            return { status: 403, code: 'enrollment_code', message: deps.secrets?.bootstrap ? 'That setup code is not right.' : 'Founder setup is locked until the setup code is set in Netlify for this deploy.' };
          }
          bootstrapHash = sha256(body.enrollmentCode.trim());
        }
        const secret = newTotpSecret(), setupId = newToken();
        await t.sql`UPDATE members SET totp_pending = ${asJson({ secret, setupId, createdAt: t.now(), generation: m.auth_generation, session: c.hash, bootstrapHash })}::jsonb WHERE id = ${m.id}`;
        await audit(t, m.id, 'auth.authenticator_setup_started');
        return { ok: { secret, setupId, uri: otpauthUri(secret, m.email) } };
      });
      if (r.ok) return json(r.ok);
      if (r.status === 401) return fail(401, 'signed_out', 'Please sign in.');
      return fail(r.status, r.code, r.message);
    }
    case 'POST authenticator/recover': {
      // Founder lost their phone: a fresh email sign-in plus the one-time recovery code from Netlify.
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.member.role !== 'founder' || ctx.session.mfa !== 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const r = await inTx(deps, async t => {
        const c = await lockContext(t, ctx);
        if (!c || c.session.mfa !== 'pending') return { status: 401 };
        const { member: m } = c;
        if (factorLocked(m, t.now())) return { status: 429, code: 'too_many_codes', message: 'Too many wrong codes for this account. Wait 15 minutes, then try again.' };
        if (deps.secrets?.misconfigured || !secretOk(deps.secrets?.recovery, body.enrollmentCode)) {
          await recordFactorFailure(t, m, c.hash);
          await audit(t, m.id, 'auth.recovery_rejected');
          return { status: 403, code: 'enrollment_code', message: 'That recovery code is not right.' };
        }
        const used = await t.sql`INSERT INTO secret_uses (org_id, purpose, secret_hash, context, member_id, used_at) VALUES (${t.orgId}, 'founder_recovery', ${sha256(body.enrollmentCode.trim())}, ${deps.deployContext || 'unknown'}, ${m.id}, ${iso(t.now())}) ON CONFLICT DO NOTHING RETURNING purpose`;
        if (!used[0]) { await audit(t, m.id, 'auth.recovery_code_reused'); return { status: 403, code: 'recovery_used', message: 'That recovery code was already used. Set a new one in Netlify, then try again.' }; }
        await t.sql`UPDATE members SET totp_secret = NULL, totp_enabled = false, totp_pending = NULL, totp_last_step = -1, mfa_failures = '[]'::jsonb WHERE id = ${m.id}`;
        await rotateAccess(t, m.id, { keepSession: c.hash });
        await t.sql`UPDATE sessions SET mfa = 'none', via = ${c.session.via + '+recovery'} WHERE sid_hash = ${c.hash}`;
        await enqueue(t, m, 'Your SpinFamily authenticator was reset', `Your authenticator app was reset with the recovery code at ${iso(t.now())}. Every other sign-in was ended.\n\nIf this wasn't you, sign in now, set up your authenticator again, and replace the recovery code in Netlify.`);
        await audit(t, m.id, 'auth.authenticator_recovered');
        return { ok: true };
      });
      if (r.ok) return json({ ok: true });
      if (r.status === 401) return fail(401, 'signed_out', 'Please sign in.');
      return fail(r.status, r.code, r.message);
    }
    case 'POST authenticator/confirm': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const r = await inTx(deps, async t => {
        const c = await lockContext(t, ctx);
        if (!c || c.session.mfa === 'pending') return { status: 401 };
        const { member: m } = c;
        const p = m.totp_pending;
        // Only the exact setup started in this session, under the current generation, can be confirmed.
        if (!p || p.setupId !== body.setupId || p.session !== c.hash || p.generation !== m.auth_generation || t.now() - p.createdAt > SETUP_TTL_MS) return { status: 400, code: 'expired', message: 'Setup expired or was replaced. Start again.' };
        if (factorLocked(m, t.now())) return { status: 429, code: 'too_many_codes', message: 'Too many wrong codes for this account. Wait 15 minutes, then try again.' };
        await barrier(t, 'factor.confirm.locked');
        const step = verifyTotp(p.secret, String(body.code || '').slice(0, 12), t.now());
        if (step === null) { await recordFactorFailure(t, m, null); return { status: 400, code: 'bad_code', message: "That code didn't match. Check the key was entered correctly and try the newest code." }; }
        if (p.bootstrapHash) {
          const used = await t.sql`INSERT INTO secret_uses (org_id, purpose, secret_hash, context, member_id, used_at) VALUES (${t.orgId}, 'founder_bootstrap', ${p.bootstrapHash}, ${deps.deployContext || 'unknown'}, ${m.id}, ${iso(t.now())}) ON CONFLICT DO NOTHING RETURNING purpose`;
          if (!used[0]) return { status: 403, code: 'bootstrap_used', message: 'The one-time setup code was already used.' };
        }
        await t.sql`UPDATE members SET totp_secret = ${p.secret}, totp_enabled = true, totp_last_step = ${step}, totp_pending = NULL, mfa_failures = '[]'::jsonb WHERE id = ${m.id}`;
        // A new factor starts a new generation: every other session and link for this person ends.
        await rotateAccess(t, m.id, { keepSession: c.hash });
        await t.sql`UPDATE sessions SET mfa = 'verified' WHERE sid_hash = ${c.hash}`;
        await audit(t, m.id, 'auth.authenticator_enabled');
        return { ok: true };
      });
      if (r.ok) return json({ ok: true });
      if (r.status === 401) return fail(401, 'signed_out', 'Please sign in.');
      return fail(r.status, r.code, r.message);
    }
  }
  return null;
}

// ---------- Team (founder only, with authenticator) ----------
async function teamRoutes(parts, method, body, env) {
  const { member: me } = env;
  env.need('team.manage');
  if (method === 'GET' && !parts.length) {
    return json({ members: (await orgMembers(env)).map(publicMember), roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r })) });
  }
  if (method === 'POST' && parts[0] === 'invite') {
    const email = normalizeEmail(body.email); if (!email) throw new Invalid('A valid email is required');
    const role = oneOf(body.role, 'role', Object.keys(ROLES));
    if (role === 'founder') throw new Invalid('Only one founder account is allowed');
    const name = text(body.name, 'name', 80, { required: true });
    const title = text(body.title, 'title', 80) || ROLES[role].label;
    const id = await inTx(env, async t => {
      if (await memberByEmail(t, email)) throw new Invalid('That person is already on the team list');
      // A person can belong to several companies: reuse their member record if it exists.
      await t.sql`INSERT INTO members (id, email, name) VALUES (${newId('m')}, ${email}, ${name}) ON CONFLICT (email) DO NOTHING`;
      const mid = (await t.sql`SELECT id FROM members WHERE email = ${email} FOR UPDATE`)[0].id;
      await t.sql`INSERT INTO memberships (org_id, member_id, role, title, status, invited_by) VALUES (${t.orgId}, ${mid}, ${role}, ${title}, 'invited', ${me.id})`;
      await audit(t, me.id, 'team.invited', mid, { role });
      return mid;
    });
    return json({ member: publicMember(await memberById(env, id)) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    if (parts[0] === me.id) throw new Invalid("You can't change your own access here");
    const result = await inTx(env, async t => {
      const m = await memberById(t, parts[0], { lock: true });
      if (!m) return null;
      await barrier(t, 'team.change.locked');
      if (body.email !== undefined) {
        // Change a teammate's sign-in email (e.g. moving them to a company address).
        const email = normalizeEmail(body.email); if (!email) throw new Invalid('A valid email is required');
        if ((await t.sql`SELECT id FROM members WHERE email = ${email} AND id <> ${m.id}`)[0]) throw new Invalid('Another person already uses that email');
        await t.sql`UPDATE members SET email = ${email} WHERE id = ${m.id}`;
        await rotateAccess(t, m.id);
        await audit(t, me.id, 'team.email_changed', m.id);
        return m.id;
      }
      const action = oneOf(body.action, 'action', ['revoke', 'restore', 'sign_out_everywhere', 'reset_authenticator']);
      if (action === 'reset_authenticator') await t.sql`UPDATE members SET totp_secret = NULL, totp_enabled = false, totp_pending = NULL, totp_last_step = -1, mfa_failures = '[]'::jsonb WHERE id = ${m.id}`;
      if (action === 'revoke') await t.sql`UPDATE memberships SET status = 'revoked' WHERE org_id = ${t.orgId} AND member_id = ${m.id}`;
      if (action === 'restore') await t.sql`UPDATE memberships SET status = 'invited' WHERE org_id = ${t.orgId} AND member_id = ${m.id} AND status = 'revoked'`;
      // Every one of these ends all of the person's sessions and outstanding links (R2-01).
      await rotateAccess(t, m.id);
      await audit(t, me.id, `team.${action}`, m.id);
      return m.id;
    });
    if (!result) return notFound();
    return json({ member: publicMember(await memberById(env, result)) });
  }
  return notFound();
}
