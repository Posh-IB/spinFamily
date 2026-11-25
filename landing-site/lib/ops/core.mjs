// SpinFamily Pilot Operations API core (SF-PILOT-OPS-001): routing, sign-in, sessions, team, audit.
// Pure request handler: all I/O comes in through `deps` so it runs the same in tests and on Netlify.
//
// deps = { sql, files, orgId, now, origin, deployContext, netlifyUser, mailbox, sendMail, log }
//   sql   – tagged-template Postgres client (Netlify Database)
//   files – { put(key, bytes, meta), get(key) } file storage (Netlify Blobs)
import {
  SESSION_COOKIE, LINK_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, MFA_PENDING_MS,
  sha256, newToken, normalizeEmail, parseCookies, sessionCookie, clearCookie,
  newTotpSecret, verifyTotp, otpauthUri,
} from './security.mjs';
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
export async function audit(deps, actor, action, target = null, extra = {}) {
  try { await deps.sql`INSERT INTO audit_events (org_id, at, actor, action, target, extra) VALUES (${deps.orgId}, ${iso(deps.now())}, ${actor || 'anonymous'}, ${action}, ${target}, ${asJson(extra)}::jsonb)`; }
  catch (e) { deps.log?.({ component: 'ops-audit', state: 'write_failed', action, code: e?.code || null }); }
}

// ---------- Members ----------
const MEMBER_COLS = 'm.id, m.email, m.name, m.totp_secret, m.totp_enabled, m.totp_last_step, m.totp_pending, m.link_requests, m.sessions_valid_after, m.last_sign_in_at, m.created_at, ms.role, ms.title, ms.status, ms.invited_by';
async function memberByEmail(deps, email) {
  const r = await deps.sql`SELECT m.id, m.email, m.name, m.totp_secret, m.totp_enabled, m.totp_last_step, m.totp_pending, m.link_requests, m.sessions_valid_after, m.last_sign_in_at, m.created_at, ms.role, ms.title, ms.status, ms.invited_by
    FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.email = ${email}`;
  return r[0] ? fixMember(r[0]) : null;
}
export async function memberById(deps, id) {
  const r = await deps.sql`SELECT m.id, m.email, m.name, m.totp_secret, m.totp_enabled, m.totp_last_step, m.totp_pending, m.link_requests, m.sessions_valid_after, m.last_sign_in_at, m.created_at, ms.role, ms.title, ms.status, ms.invited_by
    FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} WHERE m.id = ${id}`;
  return r[0] ? fixMember(r[0]) : null;
}
export async function orgMembers(deps) {
  const r = await deps.sql`SELECT m.id, m.email, m.name, m.totp_secret, m.totp_enabled, m.totp_last_step, m.totp_pending, m.link_requests, m.sessions_valid_after, m.last_sign_in_at, m.created_at, ms.role, ms.title, ms.status, ms.invited_by
    FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.org_id = ${deps.orgId} ORDER BY ms.created_at`;
  return r.map(fixMember);
}
function fixMember(r) {
  const m = row(r);
  m.totp_last_step = Number(m.totp_last_step); m.sessions_valid_after = Number(m.sessions_valid_after);
  return m;
}
void MEMBER_COLS;

export function publicMember(m) {
  return { id: m.id, name: m.name, email: m.email, title: m.title, role: m.role, roleLabel: ROLES[m.role]?.label, riccTitle: ROLES[m.role]?.riccTitle, status: m.status, createdAt: m.created_at, lastSignInAt: m.last_sign_in_at || null, mfaEnabled: !!m.totp_enabled };
}

async function ensureFounder(deps) {
  const email = ORG_FOUNDERS[deps.orgId];
  if (!email) return null;
  const existing = await memberByEmail(deps, email);
  if (existing) return existing;
  const found = await deps.sql`SELECT id FROM members WHERE email = ${email}`;
  const id = found[0]?.id || newId('m');
  if (!found[0]) await deps.sql`INSERT INTO members (id, email, name) VALUES (${id}, ${email}, ${'Dion Thornton'}) ON CONFLICT (email) DO NOTHING`;
  const real = (await deps.sql`SELECT id FROM members WHERE email = ${email}`)[0].id;
  await deps.sql`INSERT INTO memberships (org_id, member_id, role, title, status, invited_by) VALUES (${deps.orgId}, ${real}, 'founder', 'Founder', 'invited', 'bootstrap') ON CONFLICT DO NOTHING`;
  return memberByEmail(deps, email);
}

function enrollmentCodeOk(deps, code) {
  const expected = deps.founderEnrollmentCode;
  if (!expected || typeof code !== 'string' || code.length > 200) return false;
  return sha256(code.trim()) === sha256(expected.trim());
}

// ---------- Sessions ----------
async function loadSession(req, deps) {
  const sid = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!sid || sid.length > 100) return null;
  const hash = sha256(sid);
  const s = (await deps.sql`SELECT sid_hash, member_id, org_id, created_at, last_seen, expires_at, mfa, mfa_failures, via FROM sessions WHERE sid_hash = ${hash}`)[0];
  if (!s) return null;
  for (const k of ['created_at', 'last_seen', 'expires_at', 'mfa_failures']) s[k] = Number(s[k]);
  const now = deps.now();
  const drop = async () => { await deps.sql`DELETE FROM sessions WHERE sid_hash = ${hash}`; return null; };
  if (s.org_id !== deps.orgId) return null;
  if (now > s.expires_at || now - s.last_seen > SESSION_IDLE_MS || (s.mfa === 'pending' && now - s.created_at > MFA_PENDING_MS)) return drop();
  const member = await memberById(deps, s.member_id);
  if (!member || member.status !== 'active' || s.created_at <= member.sessions_valid_after) return drop();
  if (now - s.last_seen > 60000) await deps.sql`UPDATE sessions SET last_seen = ${now} WHERE sid_hash = ${hash}`;
  return { hash, session: s, member };
}

async function startSession(deps, member, via) {
  const sid = newToken(), now = deps.now();
  const mfa = member.totp_enabled ? 'pending' : 'none';
  await deps.sql`INSERT INTO sessions (sid_hash, member_id, org_id, created_at, last_seen, expires_at, mfa, via) VALUES (${sha256(sid)}, ${member.id}, ${deps.orgId}, ${now}, ${now}, ${now + SESSION_MAX_MS}, ${mfa}, ${via})`;
  return { cookie: sessionCookie(sid, Math.floor(SESSION_MAX_MS / 1000)), mfa: mfa === 'pending' ? 'pending' : false };
}

async function activate(deps, member) {
  await deps.sql`UPDATE memberships SET status = 'active' WHERE org_id = ${deps.orgId} AND member_id = ${member.id} AND status = 'invited'`;
  await deps.sql`UPDATE members SET last_sign_in_at = ${iso(deps.now())} WHERE id = ${member.id}`;
  return memberById(deps, member.id);
}

// ---------- Email ----------
export async function sendTo(deps, member, subject, body) {
  await deps.sendMail({ from: { name: 'SpinFamily Operations', address: deps.mailbox }, replyTo: deps.mailbox, to: { address: member.email, name: '' }, subject: subject.slice(0, 150), text: `Hi ${member.name.split(' ')[0]},\n\n${body}\n\nSpinFamily Operations\nA Rootlayer Software LLC product.`, disableFileAccess: true, disableUrlAccess: true });
}

// ---------- Routing ----------
export async function handle(req, deps) {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/operations\/api\/?/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const method = req.method.toUpperCase();

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

    if (parts[0] === 'auth') { const r = await authRoutes(parts.slice(1), method, body, req, deps); if (r) return r; }
    if (parts[0] === 'public') { const r = await publicSurveyRoutes(parts.slice(1), method, body, deps); if (r) return r; }

    const ctx = await loadSession(req, deps);
    if (!ctx) return fail(401, 'signed_out', 'Please sign in.');
    if (ctx.session.mfa === 'pending') return fail(401, 'mfa_required', 'Enter your authenticator code.');
    // Parent details are behind a second factor for everyone (IR-07): no data until the authenticator is set up and used.
    if (ctx.session.mfa !== 'verified') return fail(403, 'authenticator_required', 'Set up your authenticator app under Team & security to continue.');
    const { member } = ctx;
    const verified = ctx.session.mfa === 'verified';
    const env = {
      ...deps, member, session: ctx.session,
      need: action => { if (!can(member, action)) throw new Forbidden(); if (STEP_UP.has(action) && !verified) throw new Forbidden(true); },
      has: action => can(member, action) && (!STEP_UP.has(action) || verified),
      audit: (action, target, extra) => audit(deps, member.id, action, target, extra),
    };
    const sub = parts.slice(1);
    switch (parts[0]) {
      case 'team': return await teamRoutes(sub, method, body, env);
      case 'audit': if (method === 'GET') { env.need('audit.view'); return json({ audit: rows(await deps.sql`SELECT at, actor, action, target FROM audit_events WHERE org_id = ${deps.orgId} ORDER BY id DESC LIMIT 200`) }); } break;
      case 'resources': return await docRoutes(sub, method, body, env);
      case 'approvals': return await approvalRoutes(sub, method, body, env);
      case 'content': return await contentRoutes(sub, method, body, env);
      case 'research': return await researchRoutes(sub, method, body, env);
      default: { const r = await recordRoutes(parts, method, body, env); if (r) return r; }
    }
    return notFound();
  } catch (e) {
    if (e.invalid) return fail(400, 'invalid', e.message);
    if (e.stepUp) return fail(403, 'step_up_required', 'This needs your authenticator code. Set it up or enter it under Team & security.');
    if (e.status === 403) return fail(403, 'forbidden', "You don't have access to that.");
    if (e.conflict) return fail(409, 'conflict', 'Someone changed this while you were editing. Reload to see the latest, then make your change again.');
    if (e.code === '23505') return fail(409, 'duplicate', 'That already exists.');
    // Logs carry the error class and database code only, never values that could contain personal data.
    deps.log?.({ component: 'ops-api', state: 'error', name: e?.name || 'Error', code: e?.code || null, route: parts.slice(0, 2).join('/') });
    return fail(500, 'server_error', 'Something went wrong. Reload and check whether your change was saved before trying again.');
  }
}

// ---------- Auth ----------
async function authRoutes(parts, method, body, req, deps) {
  switch (`${method} ${parts.join('/')}`) {
    case 'POST request': {
      // Always the same answer, so the endpoint can't be used to find out who is on the team.
      const generic = json({ ok: true, message: 'If that email belongs to the SpinFamily team, a sign-in link is on its way.' });
      const email = normalizeEmail(body.email);
      if (!email) return generic;
      if (email === ORG_FOUNDERS[deps.orgId]) await ensureFounder(deps);
      const member = await memberByEmail(deps, email);
      if (!member || !['active', 'invited'].includes(member.status)) { await audit(deps, null, 'auth.link_denied'); return generic; }
      const now = deps.now();
      await deps.sql`DELETE FROM login_links WHERE expires_at < ${now - 864e5}`;
      await deps.sql`DELETE FROM sessions WHERE expires_at < ${now}`;
      // Atomic throttle (IR-01): the row lock serializes parallel requests; at most 3 links per 15 minutes.
      const claimed = await deps.sql`UPDATE members SET link_requests = (
          SELECT coalesce(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(link_requests) x WHERE (x #>> '{}')::bigint > ${now - LINK_TTL_MS}
        ) || ${asJson([now])}::jsonb
        WHERE id = ${member.id} AND (SELECT count(*) FROM jsonb_array_elements(link_requests) x WHERE (x #>> '{}')::bigint > ${now - LINK_TTL_MS}) < 3 RETURNING id`;
      if (!claimed[0]) { await audit(deps, member.id, 'auth.link_throttled'); return generic; }
      const token = newToken();
      await deps.sql`INSERT INTO login_links (token_hash, member_id, org_id, expires_at) VALUES (${sha256(token)}, ${member.id}, ${deps.orgId}, ${now + LINK_TTL_MS})`;
      const link = `${deps.origin}/operations/#signin=${token}`;
      try {
        await sendTo(deps, member, 'Your SpinFamily Operations sign-in link', `Use this link to sign in to the SpinFamily Pilot Operations workspace:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask to sign in, you can ignore this email; nobody can get in without it.`);
        await audit(deps, member.id, 'auth.link_sent');
      } catch { await audit(deps, member.id, 'auth.link_send_failed'); }
      return generic;
    }
    case 'POST verify': {
      const token = typeof body.token === 'string' && body.token.length < 100 ? body.token : '';
      const bad = () => fail(400, 'link_invalid', 'That sign-in link has expired or was already used. Request a new one.');
      if (!token) return bad();
      // Atomic: only one request can claim the link.
      const used = await deps.sql`UPDATE login_links SET used_at = ${deps.now()} WHERE token_hash = ${sha256(token)} AND used_at IS NULL AND expires_at >= ${deps.now()} AND org_id = ${deps.orgId} RETURNING member_id`;
      // (Revocation, restore and sign-out-everywhere mark every outstanding link as used, so a link sent before them can't be claimed here.)
      if (!used[0]) { await audit(deps, null, 'auth.link_rejected'); return bad(); }
      let member = await memberById(deps, used[0].member_id);
      if (!member || !['active', 'invited'].includes(member.status)) return bad();
      member = await activate(deps, member);
      if (!member || member.status !== 'active') return bad();
      const s = await startSession(deps, member, 'email-link');
      await audit(deps, member.id, 'auth.signed_in', null, { via: 'email-link' });
      return json({ ok: true, mfa: s.mfa }, 200, { 'set-cookie': s.cookie });
    }
    case 'POST preview': {
      // Preview deploys only: Netlify team login has already verified who this is.
      if (deps.deployContext === 'production' || !deps.netlifyUser?.email) return notFound();
      const email = normalizeEmail(deps.netlifyUser.email);
      if (email === ORG_FOUNDERS[deps.orgId]) await ensureFounder(deps);
      let member = email && await memberByEmail(deps, email);
      if (!member || !['active', 'invited'].includes(member.status)) return fail(403, 'forbidden', 'Your Netlify account is not on the SpinFamily team list.');
      member = await activate(deps, member);
      const s = await startSession(deps, member, 'netlify-team-preview');
      await audit(deps, member.id, 'auth.signed_in', null, { via: 'netlify-team-preview' });
      return json({ ok: true, mfa: s.mfa }, 200, { 'set-cookie': s.cookie });
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
      return json({
        member: publicMember(member), org,
        mfa: session.mfa === 'pending' ? 'pending' : verified ? 'verified' : 'none',
        needsAuthenticator: !member.totp_enabled,
        founderEnrollmentCodeRequired: member.role === 'founder' && !member.totp_enabled,
        permissions: session.mfa === 'pending' ? [] : permissionsFor(member).filter(a => !STEP_UP.has(a) || verified),
        previewDeploy: deps.deployContext !== 'production',
      });
    }
    case 'POST mfa': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa !== 'pending') return fail(401, 'signed_out', 'Please sign in again.');
      const { member, hash } = ctx;
      const step = verifyTotp(member.totp_secret, String(body.code || ''), deps.now(), member.totp_last_step);
      // Consume the time step atomically across all sessions so one code can never be used twice (IR-01).
      const consumed = step === null ? [] : await deps.sql`UPDATE members SET totp_last_step = ${step} WHERE id = ${member.id} AND totp_last_step < ${step} RETURNING id`;
      if (!consumed[0]) {
        const f = (await deps.sql`UPDATE sessions SET mfa_failures = mfa_failures + 1 WHERE sid_hash = ${hash} RETURNING mfa_failures`)[0];
        if (!f || Number(f.mfa_failures) >= 5) { await deps.sql`DELETE FROM sessions WHERE sid_hash = ${hash}`; await audit(deps, member.id, 'auth.mfa_locked'); return fail(401, 'signed_out', 'Too many wrong codes. Request a new sign-in link.'); }
        await audit(deps, member.id, 'auth.mfa_failed');
        return fail(400, 'bad_code', "That code didn't match. Try the newest code in your authenticator app.");
      }
      const ok = await deps.sql`UPDATE sessions SET mfa = 'verified' WHERE sid_hash = ${hash} AND mfa = 'pending' RETURNING sid_hash`;
      if (!ok[0]) return fail(401, 'signed_out', 'Please sign in again.');
      await audit(deps, member.id, 'auth.mfa_verified');
      return json({ ok: true });
    }
    case 'POST authenticator/setup': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const { member } = ctx;
      if (member.totp_enabled && ctx.session.mfa !== 'verified') return fail(403, 'step_up_required', 'Enter your current code first.');
      // IR-07: the founder's first authenticator needs a one-time code stored in Netlify's settings,
      // which proves the person enrolling also controls the hosting account, not just the mailbox.
      if (member.role === 'founder' && !member.totp_enabled && !enrollmentCodeOk(deps, body.enrollmentCode)) {
        await audit(deps, member.id, 'auth.enrollment_code_rejected');
        return fail(403, 'enrollment_code', deps.founderEnrollmentCode ? 'That setup code is not right.' : 'Founder setup is locked until OPS_FOUNDER_ENROLLMENT_CODE is set in Netlify.');
      }
      const secret = newTotpSecret();
      await deps.sql`UPDATE members SET totp_pending = ${asJson({ secret, createdAt: deps.now() })}::jsonb WHERE id = ${member.id}`;
      await audit(deps, member.id, 'auth.authenticator_setup_started');
      return json({ secret, uri: otpauthUri(secret, member.email) });
    }
    case 'POST authenticator/recover': {
      // Founder lost their phone: a fresh email sign-in plus the Netlify setup code resets the authenticator.
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.member.role !== 'founder' || ctx.session.mfa !== 'pending') return fail(401, 'signed_out', 'Please sign in.');
      if (!enrollmentCodeOk(deps, body.enrollmentCode)) { await audit(deps, ctx.member.id, 'auth.recovery_rejected'); return fail(403, 'enrollment_code', 'That setup code is not right.'); }
      await deps.sql`UPDATE members SET totp_secret = NULL, totp_enabled = false, totp_pending = NULL, sessions_valid_after = ${deps.now()} WHERE id = ${ctx.member.id}`;
      await deps.sql`UPDATE sessions SET mfa = 'none', created_at = ${deps.now() + 1} WHERE sid_hash = ${ctx.hash}`;
      await audit(deps, ctx.member.id, 'auth.authenticator_recovered');
      return json({ ok: true });
    }
    case 'POST authenticator/confirm': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const { member, hash } = ctx;
      const p = member.totp_pending;
      if (!p || deps.now() - p.createdAt > 15 * 60 * 1000) return fail(400, 'expired', 'Setup expired. Start again.');
      const step = verifyTotp(p.secret, String(body.code || ''), deps.now());
      if (step === null) return fail(400, 'bad_code', "That code didn't match. Check the key was entered correctly and try the newest code.");
      await deps.sql`UPDATE members SET totp_secret = ${p.secret}, totp_enabled = true, totp_last_step = ${step}, totp_pending = NULL WHERE id = ${member.id}`;
      await deps.sql`UPDATE sessions SET mfa = 'verified' WHERE sid_hash = ${hash}`;
      await audit(deps, member.id, 'auth.authenticator_enabled');
      return json({ ok: true });
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
    if (await memberByEmail(env, email)) throw new Invalid('That person is already on the team list');
    // A person can belong to several companies: reuse their member record if it exists.
    let id = (await env.sql`SELECT id FROM members WHERE email = ${email}`)[0]?.id;
    if (!id) { id = newId('m'); await env.sql`INSERT INTO members (id, email, name) VALUES (${id}, ${email}, ${name})`; }
    await env.sql`INSERT INTO memberships (org_id, member_id, role, title, status, invited_by) VALUES (${env.orgId}, ${id}, ${role}, ${title}, 'invited', ${me.id})`;
    await env.audit('team.invited', id, { role });
    return json({ member: publicMember(await memberById(env, id)) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    const m = await memberById(env, parts[0]); if (!m) return notFound();
    if (m.id === me.id) throw new Invalid("You can't change your own access here");
    if (body.email !== undefined) {
      // Change a teammate's sign-in email (e.g. moving them to a company address).
      const email = normalizeEmail(body.email); if (!email) throw new Invalid('A valid email is required');
      const clash = await env.sql`SELECT id FROM members WHERE email = ${email} AND id <> ${m.id}`;
      if (clash[0]) throw new Invalid('Another person already uses that email');
      await env.sql`UPDATE members SET email = ${email}, sessions_valid_after = ${env.now()} WHERE id = ${m.id}`;
      await env.sql`UPDATE login_links SET used_at = ${env.now()} WHERE member_id = ${m.id} AND used_at IS NULL`;
      await env.audit('team.email_changed', m.id);
      return json({ member: publicMember(await memberById(env, m.id)) });
    }
    const action = oneOf(body.action, 'action', ['revoke', 'restore', 'sign_out_everywhere', 'reset_authenticator']);
    // Any change to someone's access cancels their outstanding sign-in links (IR-01).
    await env.sql`UPDATE login_links SET used_at = ${env.now()} WHERE member_id = ${m.id} AND used_at IS NULL`;
    if (action === 'reset_authenticator') await env.sql`UPDATE members SET totp_secret = NULL, totp_enabled = false, totp_pending = NULL, sessions_valid_after = ${env.now()} WHERE id = ${m.id}`;
    if (action === 'revoke') { await env.sql`UPDATE memberships SET status = 'revoked' WHERE org_id = ${env.orgId} AND member_id = ${m.id}`; await env.sql`UPDATE members SET sessions_valid_after = ${env.now()} WHERE id = ${m.id}`; }
    if (action === 'restore') await env.sql`UPDATE memberships SET status = 'invited' WHERE org_id = ${env.orgId} AND member_id = ${m.id}`;
    if (action === 'sign_out_everywhere') await env.sql`UPDATE members SET sessions_valid_after = ${env.now()} WHERE id = ${m.id}`;
    await env.audit(`team.${action}`, m.id);
    return json({ member: publicMember(await memberById(env, m.id)) });
  }
  return notFound();
}
