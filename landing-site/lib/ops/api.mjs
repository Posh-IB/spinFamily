// SpinFamily Pilot Operations API (SF-PILOT-OPS-001, M1 + M2).
// Pure request handler: all I/O comes in through `deps` so it can be tested without Netlify.
import {
  SESSION_COOKIE, LINK_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS, MFA_PENDING_MS,
  sha256, newToken, newId, normalizeEmail, parseCookies, sessionCookie, clearCookie,
  newTotpSecret, verifyTotp, otpauthUri,
} from './security.mjs';
import { ROLES, can, permissionsFor, STEP_UP } from './permissions.mjs';
import { getAll } from './store.mjs';

export const FOUNDER_EMAIL = 'dion@spinfamilyapp.com';
export const PRODUCTION_ORIGIN = 'https://spinfamilyapp.com';
const MAX_BODY = 32 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // Netlify functions accept about 6 MB per request; base64 adds a third
const MAX_UPLOAD_BODY = 6 * 1024 * 1024;

// ---- Vocabularies (lifecycle states are kept separate on purpose: see spec section 8) ----
export const REFS = ['instagram', 'facebook', 'fbgroups', 'tiktok', 'lindsey', 'campus', 'campus-groups', 'direct', 'other', 'unknown'];
export const STATES = {
  cohort: ['pilot', 'beta', 'research', 'prospect'],
  enrollment: ['prospect', 'registration_received', 'eligibility_confirmed', 'enrolled', 'withdrawn', 'archived'],
  account: ['unknown', 'not_found', 'created', 'confirmation_pending', 'confirmed', 'disabled'],
  engagement: ['unknown', 'not_started', 'first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed', 'survey_submitted', 'pilot_completed'],
  communication: ['unknown', 'not_sent', 'queued', 'smtp_accepted', 'delivery_confirmed', 'bounced', 'failed', 'uncertain', 'opted_out'],
};
const STAGES = ['identified', 'contacted', 'meeting_scheduled', 'in_conversation', 'paused', 'closed'];
const APPROVAL = ['approved', 'pending_review', 'draft', 'retired'];
const FOLLOWUP_STATUS = ['open', 'done', 'cancelled'];

// ---- Small helpers ----
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', ...headers },
});
const fail = (status, code, message) => json({ error: { code, message } }, status);
class Invalid extends Error { constructor(m) { super(m); this.invalid = true; } }

function text(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new Invalid(`${field} is required`); return ''; }
  if (typeof v !== 'string') throw new Invalid(`${field} must be text`);
  const t = v.trim();
  if (t.length > max) throw new Invalid(`${field} is too long (max ${max})`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(t)) throw new Invalid(`${field} has invalid characters`);
  if (required && !t) throw new Invalid(`${field} is required`);
  return t;
}
function oneOf(v, field, list, fallback) {
  if (v === undefined || v === null || v === '') { if (fallback !== undefined) return fallback; throw new Invalid(`${field} is required`); }
  if (!list.includes(v)) throw new Invalid(`${field} must be one of: ${list.join(', ')}`);
  return v;
}
function date(v, field) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw new Invalid(`${field} must be a date (YYYY-MM-DD)`);
  return v;
}
function count(v, field) {
  if (v === undefined || v === null || v === '') return null; // unknown stays unknown, never zero
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 100000) throw new Invalid(`${field} must be a whole number`);
  return n;
}
function url(v, field) {
  const t = text(v, field, 500, { required: true });
  let u; try { u = new URL(t); } catch { throw new Invalid(`${field} must be a link`); }
  if (u.protocol !== 'https:') throw new Invalid(`${field} must start with https://`);
  return u.toString();
}
const maskEmail = e => {
  if (!e) return '';
  const [u, d] = e.split('@');
  return `${u.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(6, u.length - 1)))}@${d}`;
};

// ---- Audit (no personal data: ids and action names only) ----
async function audit(deps, actor, action, target = null, extra = {}) {
  const at = new Date(deps.now()).toISOString();
  await deps.store.set(`audit/${at}-${newId('a')}`, { at, actor: actor || 'anonymous', action, target, ...extra }, { onlyIfNew: true });
}
async function history(deps, entity, id, actor, changes) {
  if (!changes.length) return;
  const at = new Date(deps.now()).toISOString();
  await deps.store.set(`history/${entity}/${id}/${at}-${newId('h')}`, { at, actor, changes }, { onlyIfNew: true });
}

// ---- Members and sessions ----
async function memberByEmail(store, email) {
  const ref = await store.get(`member-email/${sha256(email)}`);
  return ref ? store.get(`members/${ref.id}`) : null;
}
async function saveMember(store, m) { await store.set(`members/${m.id}`, m); await store.set(`member-email/${sha256(m.email)}`, { id: m.id }); }

async function ensureFounder(deps) {
  const existing = await memberByEmail(deps.store, FOUNDER_EMAIL);
  if (existing) return existing;
  const m = { id: newId('m'), email: FOUNDER_EMAIL, name: 'Dion Thornton', title: 'Founder', role: 'founder', status: 'invited', createdAt: new Date(deps.now()).toISOString(), invitedBy: 'bootstrap', totp: null };
  const claim = await deps.store.set(`member-email/${sha256(m.email)}`, { id: m.id }, { onlyIfNew: true });
  if (!claim.modified) return memberByEmail(deps.store, FOUNDER_EMAIL);
  await deps.store.set(`members/${m.id}`, m);
  return m;
}

async function loadSession(req, deps) {
  const sid = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
  if (!sid || sid.length > 100) return null;
  const key = `sessions/${sha256(sid)}`;
  const s = await deps.store.get(key);
  if (!s) return null;
  const now = deps.now();
  if (now > s.expiresAt || now - s.lastSeen > SESSION_IDLE_MS || (s.mfa === 'pending' && now - s.createdAt > MFA_PENDING_MS)) { await deps.store.del(key); return null; }
  const member = await deps.store.get(`members/${s.memberId}`);
  if (!member || member.status !== 'active' || (member.sessionsValidAfter && s.createdAt < member.sessionsValidAfter)) { await deps.store.del(key); return null; }
  if (now - s.lastSeen > 60000) { s.lastSeen = now; await deps.store.set(key, s); }
  return { key, session: s, member };
}

async function startSession(deps, member, via) {
  const sid = newToken(), now = deps.now();
  const mfa = member.role === 'founder' && member.totp?.enabled ? 'pending' : false;
  await deps.store.set(`sessions/${sha256(sid)}`, { memberId: member.id, createdAt: now, lastSeen: now, expiresAt: now + SESSION_MAX_MS, mfa, via });
  return { cookie: sessionCookie(sid, Math.floor(SESSION_MAX_MS / 1000)), mfa };
}

function publicMember(m) {
  return { id: m.id, name: m.name, email: m.email, title: m.title, role: m.role, roleLabel: ROLES[m.role]?.label, riccTitle: ROLES[m.role]?.riccTitle, status: m.status, createdAt: m.createdAt, lastSignInAt: m.lastSignInAt || null, mfaEnabled: !!m.totp?.enabled };
}

// ---- Sign-in email ----
function signInMessage(member, link, mailbox) {
  const text = `Hi ${member.name.split(' ')[0]},\n\nUse this link to sign in to the SpinFamily Pilot Operations workspace:\n\n${link}\n\nThe link works once and expires in 15 minutes. If you didn't ask to sign in, you can ignore this email; nobody can get in without it.\n\nSpinFamily Operations\nA Rootlayer Software LLC product.`;
  return { from: { name: 'SpinFamily Operations', address: mailbox }, replyTo: mailbox, to: { address: member.email, name: '' }, subject: 'Your SpinFamily Operations sign-in link', text, disableFileAccess: true, disableUrlAccess: true };
}

// ---- Routing ----
export async function handle(req, deps) {
  const u = new URL(req.url);
  const path = u.pathname.replace(/^\/operations\/api\/?/, '').replace(/\/+$/, '');
  const parts = path.split('/').filter(Boolean);
  const method = req.method.toUpperCase();
  const origin = deps.origin;

  try {
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      // CSRF defence: strict same-site cookie + same origin + custom header + JSON only.
      const o = req.headers.get('origin');
      if (o && o !== origin) return fail(403, 'bad_origin', 'Request blocked.');
      if (req.headers.get('x-sf-ops') !== '1') return fail(403, 'missing_header', 'Request blocked.');
      if (!String(req.headers.get('content-type') || '').startsWith('application/json')) return fail(415, 'json_only', 'Send JSON.');
      const limit = path === 'resources/upload' ? MAX_UPLOAD_BODY : MAX_BODY;
      const declared = Number(req.headers.get('content-length') || 0);
      if (declared > limit) return fail(413, 'too_large', 'That file or request is too large.');
      const raw = await req.text();
      if (raw.length > limit) return fail(413, 'too_large', 'That file or request is too large.');
      try { body = raw ? JSON.parse(raw) : {}; } catch { return fail(400, 'bad_json', 'Invalid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'bad_json', 'Invalid JSON.');
    }

    // ---------- Public auth endpoints ----------
    if (parts[0] === 'auth') {
      const r = await authRoutes(parts.slice(1), method, body, req, deps);
      if (r) return r;
    }

    // ---------- Everything else needs a signed-in, fully verified member ----------
    const ctx = await loadSession(req, deps);
    if (!ctx) return fail(401, 'signed_out', 'Please sign in.');
    if (ctx.session.mfa === 'pending') return fail(401, 'mfa_required', 'Enter your authenticator code.');
    const { member } = ctx;
    const need = action => {
      if (!can(member, action)) { const e = new Error('forbidden'); e.status = 403; throw e; }
      if (STEP_UP.has(action) && ctx.session.mfa !== true) { const e = new Error('step_up'); e.status = 403; e.stepUp = true; throw e; }
    };
    const has = action => can(member, action) && (!STEP_UP.has(action) || ctx.session.mfa === true);
    const env = { ...deps, member, need, has, session: ctx.session };

    switch (parts[0]) {
      case 'dashboard': if (method === 'GET') return await dashboard(env); break;
      case 'participants': return await participants(parts.slice(1), method, body, env);
      case 'followups': return await followups(parts.slice(1), method, body, env);
      case 'outreach': return await outreach(parts.slice(1), method, body, env);
      case 'relationships': return await relationships(parts.slice(1), method, body, env);
      case 'resources': return await resources(parts.slice(1), method, body, env);
      case 'team': return await team(parts.slice(1), method, body, env);
      case 'audit': if (method === 'GET') { need('audit.view'); const rows = (await getAll(deps.store, 'audit/')).slice(-200).reverse(); return json({ audit: rows }); } break;
    }
    return fail(404, 'not_found', 'Not found.');
  } catch (e) {
    if (e.invalid) return fail(400, 'invalid', e.message);
    if (e.stepUp) return fail(403, 'step_up_required', 'This needs your authenticator code. Set it up or enter it under Team & security.');
    if (e.status === 403) return fail(403, 'forbidden', "You don't have access to that.");
    if (e.status === 404) return fail(404, 'not_found', 'Not found.');
    deps.log?.({ component: 'ops-api', state: 'error', message: String(e?.message || e).slice(0, 200) });
    return fail(500, 'server_error', 'Something went wrong. Nothing was changed if this was a save; try again.');
  }
}

async function authRoutes(parts, method, body, req, deps) {
  const route = `${method} ${parts.join('/')}`;
  switch (route) {
    case 'POST request': {
      // Always the same answer, so the endpoint can't be used to find out who is on the team.
      const generic = json({ ok: true, message: 'If that email belongs to the SpinFamily team, a sign-in link is on its way.' });
      const email = normalizeEmail(body.email);
      if (!email) return generic;
      if (email === FOUNDER_EMAIL) await ensureFounder(deps);
      const member = await memberByEmail(deps.store, email);
      if (!member || !['active', 'invited'].includes(member.status)) { await audit(deps, null, 'auth.link_denied'); return generic; }
      // Per-member throttle: at most 3 links per 15 minutes.
      const now = deps.now();
      const recent = (member.linkRequests || []).filter(t => now - t < LINK_TTL_MS);
      if (recent.length >= 3) { await audit(deps, member.id, 'auth.link_throttled'); return generic; }
      member.linkRequests = [...recent, now];
      await saveMember(deps.store, member);
      const token = newToken();
      await deps.store.set(`login-links/${sha256(token)}`, { memberId: member.id, expiresAt: now + LINK_TTL_MS, used: false });
      const link = `${deps.origin}/operations/#signin=${token}`;
      try { await deps.sendMail(signInMessage(member, link, deps.mailbox)); await audit(deps, member.id, 'auth.link_sent'); }
      catch { await audit(deps, member.id, 'auth.link_send_failed'); }
      return generic;
    }
    case 'POST verify': {
      const token = typeof body.token === 'string' && body.token.length < 100 ? body.token : '';
      const key = `login-links/${sha256(token)}`;
      const rec = token ? await deps.store.getWithEtag(key) : null;
      const bad = () => fail(400, 'link_invalid', 'That sign-in link has expired or was already used. Request a new one.');
      if (!rec || rec.value.used || deps.now() > rec.value.expiresAt) { await audit(deps, null, 'auth.link_rejected'); return bad(); }
      const used = await deps.store.set(key, { ...rec.value, used: true }, { onlyIfMatch: rec.etag });
      if (!used.modified) return bad(); // someone else used it first
      const member = await deps.store.get(`members/${rec.value.memberId}`);
      if (!member || !['active', 'invited'].includes(member.status)) return bad();
      member.status = 'active'; member.lastSignInAt = new Date(deps.now()).toISOString();
      await saveMember(deps.store, member);
      const s = await startSession(deps, member, 'email-link');
      await audit(deps, member.id, 'auth.signed_in', null, { via: 'email-link' });
      return json({ ok: true, mfa: s.mfa }, 200, { 'set-cookie': s.cookie });
    }
    case 'POST preview': {
      // Preview deploys only: Netlify team login has already verified who this is.
      if (deps.deployContext === 'production' || !deps.netlifyUser?.email) return fail(404, 'not_found', 'Not found.');
      const email = normalizeEmail(deps.netlifyUser.email);
      if (email === FOUNDER_EMAIL) await ensureFounder(deps);
      const member = email && await memberByEmail(deps.store, email);
      if (!member || !['active', 'invited'].includes(member.status)) return fail(403, 'forbidden', 'Your Netlify account is not on the SpinFamily team list.');
      member.status = 'active'; member.lastSignInAt = new Date(deps.now()).toISOString();
      await saveMember(deps.store, member);
      const s = await startSession(deps, member, 'netlify-team-preview');
      await audit(deps, member.id, 'auth.signed_in', null, { via: 'netlify-team-preview' });
      return json({ ok: true, mfa: s.mfa }, 200, { 'set-cookie': s.cookie });
    }
    case 'POST logout': {
      const ctx = await loadSession(req, deps).catch(() => null);
      const sid = parseCookies(req.headers.get('cookie'))[SESSION_COOKIE];
      if (sid) await deps.store.del(`sessions/${sha256(sid)}`);
      if (ctx) await audit(deps, ctx.member.id, 'auth.signed_out');
      return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
    }
    case 'GET me': {
      const ctx = await loadSession(req, deps);
      if (!ctx) return fail(401, 'signed_out', 'Please sign in.');
      const { member, session } = ctx;
      return json({
        member: publicMember(member),
        mfa: session.mfa === 'pending' ? 'pending' : session.mfa === true ? 'verified' : 'none',
        needsAuthenticator: member.role === 'founder' && !member.totp?.enabled,
        permissions: session.mfa === 'pending' ? [] : permissionsFor(member).filter(a => !STEP_UP.has(a) || session.mfa === true),
        previewDeploy: deps.deployContext !== 'production',
      });
    }
    case 'POST mfa': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa !== 'pending') return fail(401, 'signed_out', 'Please sign in again.');
      const { member } = ctx;
      const step = verifyTotp(member.totp.secret, String(body.code || ''), deps.now(), member.totp.lastStep ?? -1);
      if (step === null) {
        ctx.session.mfaFailures = (ctx.session.mfaFailures || 0) + 1;
        if (ctx.session.mfaFailures >= 5) { await deps.store.del(ctx.key); await audit(deps, member.id, 'auth.mfa_locked'); return fail(401, 'signed_out', 'Too many wrong codes. Request a new sign-in link.'); }
        await deps.store.set(ctx.key, ctx.session);
        await audit(deps, member.id, 'auth.mfa_failed');
        return fail(400, 'bad_code', "That code didn't match. Try the newest code in your authenticator app.");
      }
      member.totp.lastStep = step; await saveMember(deps.store, member);
      ctx.session.mfa = true; await deps.store.set(ctx.key, ctx.session);
      await audit(deps, member.id, 'auth.mfa_verified');
      return json({ ok: true });
    }
    case 'POST authenticator/setup': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const { member } = ctx;
      if (member.totp?.enabled && ctx.session.mfa !== true) return fail(403, 'step_up_required', 'Enter your current code first.');
      const secret = newTotpSecret();
      member.totpPending = { secret, createdAt: deps.now() };
      await saveMember(deps.store, member);
      await audit(deps, member.id, 'auth.authenticator_setup_started');
      return json({ secret, uri: otpauthUri(secret, member.email) });
    }
    case 'POST authenticator/confirm': {
      const ctx = await loadSession(req, deps);
      if (!ctx || ctx.session.mfa === 'pending') return fail(401, 'signed_out', 'Please sign in.');
      const { member } = ctx;
      if (!member.totpPending || deps.now() - member.totpPending.createdAt > 15 * 60 * 1000) return fail(400, 'expired', 'Setup expired. Start again.');
      const step = verifyTotp(member.totpPending.secret, String(body.code || ''), deps.now());
      if (step === null) return fail(400, 'bad_code', "That code didn't match. Check the key was entered correctly and try the newest code.");
      member.totp = { secret: member.totpPending.secret, enabled: true, lastStep: step, enabledAt: new Date(deps.now()).toISOString() };
      delete member.totpPending;
      await saveMember(deps.store, member);
      ctx.session.mfa = true; await deps.store.set(ctx.key, ctx.session);
      await audit(deps, member.id, 'auth.authenticator_enabled');
      return json({ ok: true });
    }
  }
  return null;
}

// ---------- Team (founder only, with authenticator) ----------
async function team(parts, method, body, env) {
  const { store, member: me } = env;
  if (method === 'GET' && !parts.length) {
    env.need('team.manage');
    const members = (await getAll(store, 'members/')).map(publicMember).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return json({ members, roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r })) });
  }
  if (method === 'POST' && parts[0] === 'invite') {
    env.need('team.manage');
    const email = normalizeEmail(body.email); if (!email) throw new Invalid('A valid email is required');
    const role = oneOf(body.role, 'role', Object.keys(ROLES));
    if (role === 'founder') throw new Invalid('Only one founder account is allowed');
    const name = text(body.name, 'name', 80, { required: true });
    const title = text(body.title, 'title', 80) || ROLES[role].label;
    if (await memberByEmail(store, email)) throw new Invalid('That person is already on the team list');
    const m = { id: newId('m'), email, name, title, role, status: 'invited', createdAt: new Date(env.now()).toISOString(), invitedBy: me.id, totp: null };
    await saveMember(store, m);
    await audit(env, me.id, 'team.invited', m.id, { role });
    return json({ member: publicMember(m) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    env.need('team.manage');
    const m = await store.get(`members/${parts[0]}`); if (!m) { const e = new Error(); e.status = 404; throw e; }
    if (m.id === me.id) throw new Invalid("You can't change your own access here");
    const action = oneOf(body.action, 'action', ['revoke', 'restore', 'sign_out_everywhere']);
    if (action === 'revoke') { m.status = 'revoked'; m.sessionsValidAfter = env.now(); }
    if (action === 'restore') m.status = 'invited';
    if (action === 'sign_out_everywhere') m.sessionsValidAfter = env.now();
    await saveMember(store, m);
    await audit(env, me.id, `team.${action}`, m.id);
    return json({ member: publicMember(m) });
  }
  return fail(404, 'not_found', 'Not found.');
}

// ---------- Participants ----------
function viewParticipant(p, env) {
  const assigned = p.assignedTo === env.member.id;
  const showContact = env.has('participants.contact.all') || assigned;
  return { ...p, email: showContact ? p.email : maskEmail(p.email), emailMasked: !showContact && !!p.email };
}
async function visibleParticipants(env) {
  const all = await getAll(env.store, 'participants/');
  if (env.has('participants.view.all')) return all;
  return all.filter(p => p.assignedTo === env.member.id);
}

async function participants(parts, method, body, env) {
  const { store, member: me } = env;
  if (method === 'GET' && !parts.length) {
    env.need('participants.view.assigned');
    const list = (await visibleParticipants(env)).map(p => viewParticipant(p, env)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json({ participants: list, states: STATES, refs: REFS, scope: env.has('participants.view.all') ? 'all' : 'assigned' });
  }
  if (method === 'POST' && !parts.length) {
    env.need('participants.create');
    const email = body.email ? normalizeEmail(body.email) : '';
    if (body.email && !email) throw new Invalid('Email address is not valid');
    if (email) {
      const claim = await store.set(`participant-email/${sha256(email)}`, { id: 'pending' }, { onlyIfNew: true });
      if (!claim.modified) throw new Invalid('A participant with that email already exists');
    }
    const now = new Date(env.now()).toISOString();
    const p = {
      id: newId('p'), firstName: text(body.firstName, 'First name', 60, { required: true }), email,
      cohort: oneOf(body.cohort, 'cohort', STATES.cohort, 'prospect'),
      enrollment: oneOf(body.enrollment, 'enrollment', STATES.enrollment, 'prospect'),
      account: oneOf(body.account, 'account', STATES.account, 'unknown'),
      engagement: oneOf(body.engagement, 'engagement', STATES.engagement, 'unknown'),
      communication: oneOf(body.communication, 'communication', STATES.communication, 'unknown'),
      technicalSource: null, // only set by form intake; never edited by hand
      reportedSource: oneOf(body.reportedSource, 'reported source', REFS, 'unknown'),
      assignedTo: me.role === 'coordinator' ? me.id : (body.assignedTo || null),
      isTest: false, origin: 'manual', intake: null,
      notes: text(body.notes, 'notes', 1000), createdAt: now, updatedAt: now, createdBy: me.id,
    };
    if (email) await store.set(`participant-email/${sha256(email)}`, { id: p.id });
    await store.set(`participants/${p.id}`, p);
    await history(env, 'participant', p.id, me.id, [{ field: 'created', to: p.enrollment }]);
    await audit(env, me.id, 'participant.created', p.id);
    return json({ participant: viewParticipant(p, env) }, 201);
  }
  if (parts[0]) {
    const p = await store.get(`participants/${parts[0]}`);
    const visible = p && (env.has('participants.view.all') || p.assignedTo === me.id);
    if (!visible) return fail(404, 'not_found', 'Not found.');
    if (method === 'GET') {
      const h = await getAll(store, `history/participant/${p.id}/`);
      return json({ participant: viewParticipant(p, env), history: h });
    }
    if (method === 'PATCH') {
      env.need('participants.update.assigned');
      const changes = [];
      const setField = (f, v) => { if (v !== undefined && v !== p[f]) { changes.push({ field: f, from: p[f], to: v }); p[f] = v; } };
      for (const f of ['enrollment', 'account', 'engagement', 'communication', 'cohort']) if (body[f] !== undefined) setField(f, oneOf(body[f], f, STATES[f]));
      if (body.reportedSource !== undefined) setField('reportedSource', oneOf(body.reportedSource, 'reported source', REFS));
      if (body.notes !== undefined) setField('notes', text(body.notes, 'notes', 1000));
      if (body.firstName !== undefined) setField('firstName', text(body.firstName, 'First name', 60, { required: true }));
      if (body.assignedTo !== undefined) {
        env.need('participants.assign');
        if (body.assignedTo !== null) { const m = await store.get(`members/${body.assignedTo}`); if (!m || m.status === 'revoked') throw new Invalid('Unknown team member'); }
        setField('assignedTo', body.assignedTo);
      }
      if (body.isTest !== undefined) { env.need('participants.markTest'); setField('isTest', !!body.isTest); }
      if (body.technicalSource !== undefined || body.email !== undefined) throw new Invalid('Email and technical source can only be changed by the founder through a data correction');
      if (!changes.length) return json({ participant: viewParticipant(p, env) });
      p.updatedAt = new Date(env.now()).toISOString();
      await store.set(`participants/${p.id}`, p);
      const nameOf = async id => id ? ((await store.get(`members/${id}`))?.name || 'former member') : 'nobody';
      const logged = [];
      for (const c of changes) {
        if (c.field === 'notes') logged.push({ field: 'notes', to: '(edited)' });
        else if (c.field === 'assignedTo') logged.push({ field: 'assigned to', from: await nameOf(c.from), to: await nameOf(c.to) });
        else logged.push({ field: c.field, from: c.from, to: c.to });
      }
      await history(env, 'participant', p.id, me.id, logged);
      await audit(env, me.id, 'participant.updated', p.id, { fields: changes.map(c => c.field) });
      return json({ participant: viewParticipant(p, env) });
    }
  }
  return fail(404, 'not_found', 'Not found.');
}

// Pilot form intake (called by the form event function). Idempotent per email.
export async function ingestPilotSubmission(store, data, nowIso) {
  const email = normalizeEmail(data?.email);
  const firstName = typeof data?.first_name === 'string' ? data.first_name.trim().slice(0, 60) : '';
  if (!email || !firstName || data?.consent !== 'yes' || (data.company !== undefined && data.company !== '')) return 'skipped_invalid';
  const source = typeof data.source === 'string' && /^[\w-]{1,40}$/.test(data.source) ? data.source : 'unknown';
  const id = newId('p');
  const claim = await store.set(`participant-email/${sha256(email)}`, { id }, { onlyIfNew: true });
  if (!claim.modified) {
    // Already known: add intake evidence to the existing record's history only.
    const ref = await store.get(`participant-email/${sha256(email)}`);
    if (ref?.id) await store.set(`history/participant/${ref.id}/${nowIso}-${newId('h')}`, { at: nowIso, actor: 'pilot-form', changes: [{ field: 'intake', to: `repeat submission (source: ${source})` }] }, { onlyIfNew: true });
    return 'duplicate';
  }
  const p = {
    id, firstName, email, cohort: 'pilot', enrollment: 'registration_received', account: 'unknown', engagement: 'unknown', communication: 'unknown',
    technicalSource: source, reportedSource: 'unknown', assignedTo: null, isTest: null, origin: 'pilot-form',
    intake: { form: 'pilot', receivedAt: nowIso, childrenUnder10: typeof data.children_under_10 === 'string' ? data.children_under_10.slice(0, 12) : null },
    notes: '', createdAt: nowIso, updatedAt: nowIso, createdBy: 'pilot-form',
  };
  await store.set(`participants/${id}`, p);
  await store.set(`history/participant/${id}/${nowIso}-${newId('h')}`, { at: nowIso, actor: 'pilot-form', changes: [{ field: 'created', to: 'registration_received' }] }, { onlyIfNew: true });
  return 'created';
}

// ---------- Follow-ups ----------
async function followups(parts, method, body, env) {
  const { store, member: me } = env;
  env.need('followups.manage');
  const all = await getAll(store, 'followups/');
  const mine = f => env.has('followups.view.all') || f.assignedTo === me.id;
  if (method === 'GET' && !parts.length) return json({ followups: all.filter(mine).sort((a, b) => (a.dueDate || '9').localeCompare(b.dueDate || '9')) });
  if (method === 'POST' && !parts.length) {
    const subjectType = oneOf(body.subjectType, 'subject type', ['participant', 'relationship', 'general'], 'general');
    const subjectId = subjectType === 'general' ? null : text(body.subjectId, 'subject', 40, { required: true });
    if (subjectId) {
      const s = await store.get(`${subjectType === 'participant' ? 'participants' : 'relationships'}/${subjectId}`);
      if (!s || (subjectType === 'participant' && !env.has('participants.view.all') && s.assignedTo !== me.id)) throw new Invalid('Unknown record');
    }
    let assignedTo = me.id;
    if (body.assignedTo && body.assignedTo !== me.id) {
      if (me.role !== 'founder') throw new Invalid('You can only assign follow-ups to yourself');
      const m = await store.get(`members/${body.assignedTo}`); if (!m || m.status === 'revoked') throw new Invalid('Unknown team member');
      assignedTo = m.id;
    }
    const now = new Date(env.now()).toISOString();
    const f = { id: newId('f'), title: text(body.title, 'What needs to happen', 200, { required: true }), subjectType, subjectId, dueDate: date(body.dueDate, 'due date'), assignedTo, status: 'open', outcome: '', createdAt: now, updatedAt: now, createdBy: me.id };
    await store.set(`followups/${f.id}`, f);
    await audit(env, me.id, 'followup.created', f.id);
    return json({ followup: f }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    const f = await store.get(`followups/${parts[0]}`);
    if (!f || !mine(f)) return fail(404, 'not_found', 'Not found.');
    if (body.status !== undefined) f.status = oneOf(body.status, 'status', FOLLOWUP_STATUS);
    if (body.outcome !== undefined) f.outcome = text(body.outcome, 'outcome', 500);
    if (body.dueDate !== undefined) f.dueDate = date(body.dueDate, 'due date');
    if (body.title !== undefined) f.title = text(body.title, 'What needs to happen', 200, { required: true });
    f.updatedAt = new Date(env.now()).toISOString();
    if (f.status === 'done' && !f.completedAt) f.completedAt = f.updatedAt;
    await store.set(`followups/${f.id}`, f);
    await audit(env, me.id, 'followup.updated', f.id, { status: f.status });
    return json({ followup: f });
  }
  return fail(404, 'not_found', 'Not found.');
}

// ---------- Outreach log ----------
async function outreach(parts, method, body, env) {
  const { store, member: me } = env;
  env.need('outreach.record');
  if (method === 'GET' && !parts.length) return json({ outreach: (await getAll(store, 'outreach/')).sort((a, b) => b.date.localeCompare(a.date)), refs: REFS });
  if (method === 'POST' && !parts.length) {
    const now = new Date(env.now()).toISOString();
    const o = {
      id: newId('o'), date: date(body.date, 'date') || now.slice(0, 10), channel: oneOf(body.channel, 'channel', REFS),
      place: text(body.place, 'Organization or event', 120, { required: true }),
      approached: count(body.approached, 'People approached'), demos: count(body.demos, 'Demos'),
      reportedSignups: count(body.reportedSignups, 'Sign-ups reported'),
      followUpCommitments: text(body.followUpCommitments, 'Follow-up commitments', 500), observations: text(body.observations, 'Observations', 1000),
      blockers: text(body.blockers, 'Blockers', 500), evidence: 'field_report', recordedBy: me.id, createdAt: now,
    };
    await store.set(`outreach/${o.id}`, o);
    await audit(env, me.id, 'outreach.recorded', o.id);
    return json({ outreach: o }, 201);
  }
  return fail(404, 'not_found', 'Not found.');
}

// ---------- Institutional relationships ----------
async function relationships(parts, method, body, env) {
  const { store, member: me } = env;
  env.need('relationships.record');
  if (method === 'GET' && !parts.length) return json({ relationships: (await getAll(store, 'relationships/')).sort((a, b) => (a.nextActionDate || '9').localeCompare(b.nextActionDate || '9')), stages: STAGES });
  if (method === 'POST' && !parts.length) {
    const now = new Date(env.now()).toISOString();
    const r = {
      id: newId('r'), contactName: text(body.contactName, 'Contact name', 80, { required: true }), organization: text(body.organization, 'Organization', 120, { required: true }),
      office: text(body.office, 'Office or function', 120), stage: oneOf(body.stage, 'stage', STAGES, 'identified'),
      nextAction: text(body.nextAction, 'Next action', 200), nextActionDate: date(body.nextActionDate, 'next action date'), owner: body.owner || me.id,
      notes: text(body.notes, 'notes', 1000), log: [], offerApproved: false, agreementStatus: 'none',
      createdAt: now, updatedAt: now, createdBy: me.id,
    };
    await store.set(`relationships/${r.id}`, r);
    await audit(env, me.id, 'relationship.created', r.id);
    return json({ relationship: r }, 201);
  }
  if (parts[0]) {
    const r = await store.get(`relationships/${parts[0]}`); if (!r) return fail(404, 'not_found', 'Not found.');
    if (method === 'PATCH') {
      for (const [f, max] of [['nextAction', 200], ['notes', 1000], ['office', 120]]) if (body[f] !== undefined) r[f] = text(body[f], f, max);
      if (body.nextActionDate !== undefined) r.nextActionDate = date(body.nextActionDate, 'next action date');
      if (body.stage !== undefined) r.stage = oneOf(body.stage, 'stage', STAGES);
      if (body.offerApproved !== undefined) { env.need('relationships.approveOffer'); r.offerApproved = !!body.offerApproved; }
      r.updatedAt = new Date(env.now()).toISOString();
      await store.set(`relationships/${r.id}`, r);
      await audit(env, me.id, 'relationship.updated', r.id);
      return json({ relationship: r });
    }
    if (method === 'POST' && parts[1] === 'log') {
      const entry = { at: new Date(env.now()).toISOString(), by: me.id, kind: oneOf(body.kind, 'kind', ['meeting', 'demo', 'call', 'email', 'note']), summary: text(body.summary, 'summary', 500, { required: true }) };
      r.log = [...(r.log || []), entry].slice(-100); r.updatedAt = entry.at;
      await store.set(`relationships/${r.id}`, r);
      await audit(env, me.id, 'relationship.logged', r.id, { kind: entry.kind });
      return json({ relationship: r }, 201);
    }
  }
  return fail(404, 'not_found', 'Not found.');
}

// ---------- Company docs: shared links and uploaded files ----------
export const DEFAULT_RESOURCES = [
  { title: 'SpinFamily Social & Campus Guide', url: 'https://drive.google.com/file/d/1HL0obgvYmgcNOFAXPkuftEjqugN7zvV_/view', intendedUse: 'Lindsey\'s working guide: role, brand rules, tracking links, content plan.', approval: 'approved' },
  { title: 'Cincinnati State campus flyer', url: 'https://drive.google.com/file/d/1s7SGFY1Q6evgrE3w6fE2IrgBPeqFEI3I/view', intendedUse: 'Campus posting once Student Activities approves. QR: ?ref=campus.', approval: 'approved' },
  { title: 'Parenting Resource Center one-pager', url: 'https://drive.google.com/file/d/1Fnm6a6dPDRKgKApFbq2oldr79bIWq-ZR/view', intendedUse: 'Meeting with Parenting Resources. QR: ?ref=campus-groups.', approval: 'pending_review' },
  { title: 'Business Division one-pager', url: 'https://drive.google.com/file/d/1DExuLG-2HSGDkOr-DdfG8IJQNaJozZqP/view', intendedUse: 'Meeting with the Business Division. Offers need founder approval before use.', approval: 'pending_review' },
  { title: 'SpinFamily logo (color, transparent)', url: 'https://drive.google.com/file/d/1_TOgR0e9UUxCME81dylzCXPQXli2pT5e/view', intendedUse: 'Social posts and flyers on light backgrounds.', approval: 'approved' },
  { title: 'SpinFamily logo (reverse, transparent)', url: 'https://drive.google.com/file/d/1Dre0e_D1tXomKmBVRyHl1EItbcwh0b1S/view', intendedUse: 'Social posts and flyers on teal or dark backgrounds.', approval: 'approved' },
];
export const DOC_CATEGORIES = ['outreach', 'brand', 'research', 'training', 'policy', 'meeting', 'other'];

// File types are identified from the file's own bytes, not its name. Nothing that can run in a browser is accepted.
const FILE_TYPES = [
  { ext: ['pdf'], type: 'application/pdf', test: b => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { ext: ['png'], type: 'image/png', test: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { ext: ['jpg', 'jpeg'], type: 'image/jpeg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: ['webp'], type: 'image/webp', test: b => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45 },
  { ext: ['docx'], type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
  { ext: ['xlsx'], type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', test: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
  { ext: ['pptx'], type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', test: b => b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4 },
];
export function identifyFile(fileName, bytes) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  const t = FILE_TYPES.find(f => f.ext.includes(ext));
  return t && bytes.length >= 12 && t.test(bytes) ? { type: t.type, ext } : null;
}
function cleanFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().normalize('NFKD').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, ' ').trim();
  return (base || 'file').slice(-120);
}

// Who can see a document: the whole team, the founder only, or named people. The uploader always can.
function canSee(r, env) {
  if (env.has('resources.manage')) return true;
  if (r.uploadedBy === env.member.id) return true;
  if (r.approval === 'retired') return false;
  const a = r.audience || 'team';
  return a === 'team' || (Array.isArray(a) && a.includes(env.member.id));
}
async function parseAudience(v, env) {
  if (v === undefined || v === null || v === '' || v === 'team') return 'team';
  if (v === 'founder') return 'founder';
  if (!Array.isArray(v) || v.length > 50) throw new Invalid('Choose who can see this');
  const ids = [...new Set(v.map(String))];
  for (const id of ids) { const m = await env.store.get(`members/${id}`); if (!m || m.status === 'revoked') throw new Invalid('Unknown team member'); }
  return ids;
}
async function audienceMembers(env, audience) {
  const all = (await getAll(env.store, 'members/')).filter(m => m.status !== 'revoked');
  if (audience === 'team') return all;
  if (audience === 'founder') return all.filter(m => m.role === 'founder');
  return all.filter(m => audience.includes(m.id) || m.role === 'founder');
}
async function notifyShare(env, doc, recipients) {
  let sent = 0;
  for (const m of recipients) {
    if (m.id === env.member.id || !['active', 'invited'].includes(m.status)) continue;
    const text = `Hi ${m.name.split(' ')[0]},\n\n${env.member.name} shared "${doc.title}" with you in SpinFamily Operations.\n\n${doc.intendedUse ? doc.intendedUse + '\n\n' : ''}Open Company docs: ${env.origin}/operations/#/docs\n\nYou'll need to be signed in.\n\nSpinFamily Operations\nA Rootlayer Software LLC product.`;
    try { await env.sendMail({ from: { name: 'SpinFamily Operations', address: env.mailbox }, replyTo: env.mailbox, to: { address: m.email, name: '' }, subject: `Shared with you: ${doc.title}`.slice(0, 150), text, disableFileAccess: true, disableUrlAccess: true }); sent++; }
    catch { await audit(env, env.member.id, 'docs.notify_failed', doc.id); }
  }
  return sent;
}
const publicDoc = r => { const { fileKey, ...rest } = r; return rest; };

async function resources(parts, method, body, env) {
  const { store, member: me } = env;
  env.need('resources.view');
  let list = await getAll(store, 'resources/');
  if (!list.length && !(await store.get('meta/resources-seeded'))) {
    const now = new Date(env.now()).toISOString();
    for (const r of DEFAULT_RESOURCES) { const x = { id: newId('res'), kind: 'link', category: r.title.includes('logo') ? 'brand' : 'outreach', audience: 'team', ...r, createdAt: now, updatedAt: now }; await store.set(`resources/${x.id}`, x); }
    await store.set('meta/resources-seeded', { at: now });
    list = await getAll(store, 'resources/');
  }
  if (method === 'GET' && !parts.length) {
    const visible = list.filter(r => canSee(r, env)).map(publicDoc).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return json({ resources: visible, approvals: APPROVAL, categories: DOC_CATEGORIES, maxFileBytes: MAX_FILE_BYTES });
  }

  // Upload a file. Coordinators' uploads go to the founder for review; the founder chooses who sees theirs.
  if (method === 'POST' && parts[0] === 'upload') {
    env.need('resources.upload');
    const isFounder = me.role === 'founder';
    if (isFounder) env.need('resources.manage');
    const title = text(body.title, 'Title', 120, { required: true });
    const fileName = cleanFileName(text(body.fileName, 'File name', 200, { required: true }));
    if (typeof body.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.dataBase64)) throw new Invalid('The file did not upload correctly. Try again.');
    const bytes = new Uint8Array(Buffer.from(body.dataBase64, 'base64'));
    if (!bytes.length) throw new Invalid('That file is empty.');
    if (bytes.length > MAX_FILE_BYTES) throw new Invalid('That file is over 4 MB. Compress it or share a Drive link instead.');
    const kind = identifyFile(fileName, bytes);
    if (!kind) throw new Invalid('Upload a PDF, Word, Excel or PowerPoint file, or a PNG, JPG or WebP image.');
    const audience = isFounder ? await parseAudience(body.audience, env) : 'founder';
    const now = new Date(env.now()).toISOString();
    const id = newId('res');
    const r = {
      id, kind: 'file', title, intendedUse: text(body.intendedUse, 'What it\'s for', 300),
      category: oneOf(body.category, 'category', DOC_CATEGORIES, 'other'),
      approval: isFounder ? oneOf(body.approval, 'approval', APPROVAL, 'approved') : 'pending_review',
      audience, fileName, contentType: kind.type, size: bytes.length, fileKey: `files/${id}`,
      uploadedBy: me.id, uploadedByName: me.name, createdAt: now, updatedAt: now,
    };
    await store.putFile(r.fileKey, bytes, { resourceId: id, contentType: kind.type });
    await store.set(`resources/${id}`, r);
    await audit(env, me.id, 'docs.uploaded', id, { size: bytes.length, audience: Array.isArray(audience) ? 'named' : audience });
    let notified = 0;
    if (body.notify === true || !isFounder) notified = await notifyShare(env, r, await audienceMembers(env, audience));
    return json({ resource: publicDoc(r), notified }, 201);
  }

  if (parts[0] && parts[1] === 'file' && method === 'GET') {
    const r = await store.get(`resources/${parts[0]}`);
    if (!r || r.kind !== 'file' || !canSee(r, env)) return fail(404, 'not_found', 'Not found.');
    const f = await store.getFile(r.fileKey);
    if (!f) return fail(404, 'not_found', 'File missing.');
    await audit(env, me.id, 'docs.downloaded', r.id);
    return new Response(f.bytes, { status: 200, headers: {
      'content-type': r.contentType, 'content-length': String(f.bytes.length),
      'content-disposition': `attachment; filename="${r.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(r.fileName)}`,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': "sandbox; default-src 'none'", 'x-robots-tag': 'noindex, nofollow',
    } });
  }

  env.need('resources.manage');
  if (method === 'POST' && !parts.length) {
    const now = new Date(env.now()).toISOString();
    const r = { id: newId('res'), kind: 'link', title: text(body.title, 'title', 120, { required: true }), url: url(body.url, 'link'), intendedUse: text(body.intendedUse, 'intended use', 300), category: oneOf(body.category, 'category', DOC_CATEGORIES, 'other'), approval: oneOf(body.approval, 'approval', APPROVAL, 'draft'), audience: await parseAudience(body.audience, env), uploadedBy: me.id, uploadedByName: me.name, createdAt: now, updatedAt: now };
    await store.set(`resources/${r.id}`, r); await audit(env, me.id, 'docs.link_added', r.id);
    if (body.notify === true) await notifyShare(env, r, await audienceMembers(env, r.audience));
    return json({ resource: publicDoc(r) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    const r = await store.get(`resources/${parts[0]}`); if (!r) return fail(404, 'not_found', 'Not found.');
    const before = JSON.stringify(r.audience || 'team');
    if (body.approval !== undefined) r.approval = oneOf(body.approval, 'approval', APPROVAL);
    if (body.intendedUse !== undefined) r.intendedUse = text(body.intendedUse, 'intended use', 300);
    if (body.title !== undefined) r.title = text(body.title, 'title', 120, { required: true });
    if (body.category !== undefined) r.category = oneOf(body.category, 'category', DOC_CATEGORIES);
    if (body.audience !== undefined) r.audience = await parseAudience(body.audience, env);
    r.updatedAt = new Date(env.now()).toISOString();
    await store.set(`resources/${r.id}`, r); await audit(env, me.id, 'docs.updated', r.id, { approval: r.approval });
    let notified = 0;
    if (body.notify === true && JSON.stringify(r.audience) !== before) notified = await notifyShare(env, r, await audienceMembers(env, r.audience));
    return json({ resource: publicDoc(r), notified });
  }
  return fail(404, 'not_found', 'Not found.');
}

// ---------- Dashboard: actuals vs targets vs unknown, never a silent zero ----------
async function dashboard(env) {
  env.need('dashboard.view');
  const scopeAll = env.has('participants.view.all');
  const ps = (await visibleParticipants(env)).filter(p => p.isTest !== true);
  const fus = (await getAll(env.store, 'followups/')).filter(f => f.status === 'open' && (env.has('followups.view.all') || f.assignedTo === env.member.id));
  const rels = await getAll(env.store, 'relationships/');
  const outs = await getAll(env.store, 'outreach/');
  const today = new Date(env.now()).toISOString().slice(0, 10);
  const in14 = new Date(env.now() + 14 * 864e5).toISOString().slice(0, 10);

  const countBy = (list, f) => list.reduce((o, x) => { const k = x[f] ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const known = (list, f) => list.filter(p => p[f] && p[f] !== 'unknown');
  const metric = (id, label, value, status, definition, source) => ({ id, label, value, status, definition, source });
  const pilots = ps.filter(p => p.cohort === 'pilot');
  const formRegs = pilots.filter(p => p.origin === 'pilot-form');
  const unreviewed = formRegs.filter(p => p.isTest === null).length;
  const acct = known(ps, 'account'), eng = known(ps, 'engagement');
  const activated = eng.filter(p => !['not_started'].includes(p.engagement));
  const repeat = eng.filter(p => ['repeat_use_observed', 'survey_submitted', 'pilot_completed'].includes(p.engagement));

  return json({
    scope: scopeAll ? 'all' : 'assigned',
    generatedAt: new Date(env.now()).toISOString(),
    metrics: [
      metric('registrations', 'Pilot registrations in the workspace', pilots.length, 'actual', 'Pilot-cohort participants, excluding records marked as tests.' + (unreviewed ? ` ${unreviewed} form registration(s) not yet reviewed for test entries.` : ''), 'Pilot form intake and founder-entered records'),
      metric('target', 'Recruitment target', '10–20 families', 'target', 'Goal set in the Nov 21, 2026 launch record. A target, not a result.', 'Launch record'),
      metric('beta', 'Existing beta testers', ps.filter(p => p.cohort === 'beta').length, 'actual', 'Participants recorded in the beta cohort. Beta accounts are not automatically pilot participants.', 'Founder-entered records'),
      metric('accounts', 'App accounts confirmed', acct.length ? acct.filter(p => p.account === 'confirmed').length : null, acct.length ? 'actual' : 'unknown', `Participants whose confirmed app account has been verified. Unknown for ${ps.length - acct.length} participant(s).`, 'Founder verification (no automatic link to the app yet)'),
      metric('activation', 'Activated (generated a first plan or more)', eng.length ? activated.length : null, eng.length ? 'actual' : 'unknown', `Based on recorded engagement evidence. Unknown for ${ps.length - eng.length} participant(s). An account alone is not activation.`, 'Recorded engagement evidence'),
      metric('repeat', 'Repeat-use households', eng.length ? repeat.length : null, eng.length ? 'actual' : 'unknown', 'Repeat use observed or later stages.', 'Recorded engagement evidence'),
      metric('surveys', 'Survey completion', null, 'pending', 'Survey workspace is a later milestone (M4).', 'Not built yet'),
      metric('followups', 'Open follow-ups', fus.length, 'actual', `${fus.filter(f => f.dueDate && f.dueDate < today).length} overdue.`, 'Follow-up queue'),
      metric('relationships', 'Institutional relationships', rels.length, 'actual', 'Relationship-cultivation records. None of these is an approved partnership or agreement.', 'Relationships'),
      metric('outreach', 'Outreach sessions logged', outs.length, 'actual', 'Field reports logged by the team (self-reported).', 'Outreach log'),
    ],
    breakdowns: {
      technicalSource: countBy(formRegs, 'technicalSource'),
      reportedSource: countBy(ps, 'reportedSource'),
      account: countBy(ps, 'account'),
      engagement: countBy(ps, 'engagement'),
      communication: countBy(ps, 'communication'),
      relationshipStage: countBy(rels, 'stage'),
    },
    upcoming: rels.filter(r => r.nextActionDate && r.nextActionDate >= today && r.nextActionDate <= in14).map(r => ({ id: r.id, contactName: r.contactName, organization: r.organization, nextAction: r.nextAction, nextActionDate: r.nextActionDate })),
    dueFollowups: fus.filter(f => !f.dueDate || f.dueDate <= in14).slice(0, 10),
    recentRegistrations: formRegs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5).map(p => ({ id: p.id, firstName: p.firstName, createdAt: p.createdAt, technicalSource: p.technicalSource })),
  });
}
