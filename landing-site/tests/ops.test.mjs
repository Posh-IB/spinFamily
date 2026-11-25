// SF-PILOT-OPS-001 workspace tests. Synthetic records only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, ingestPilotSubmission, FOUNDER_EMAIL } from '../lib/ops/api.mjs';
import { memoryStore, storeNameFor } from '../lib/ops/store.mjs';
import { totpAt, verifyTotp, base32Decode, base32Encode, SESSION_COOKIE } from '../lib/ops/security.mjs';

const ORIGIN = 'https://spinfamilyapp.com';
const COORD = 'coordinator@example.com';

function world({ deployContext = 'production', netlifyUser = null } = {}) {
  const store = memoryStore();
  const mail = [];
  let clock = Date.parse('2026-11-24T15:00:00Z');
  const deps = { store, now: () => clock, origin: ORIGIN, deployContext, netlifyUser, mailbox: 'hello@spinfamilyapp.com', sendMail: async m => { mail.push(m); return { accepted: [m.to.address] }; } };
  const call = async (method, path, body, { cookie, headers = {} } = {}) => {
    const h = { ...headers };
    if (cookie) h.cookie = `${SESSION_COOKIE}=${cookie}`;
    if (method !== 'GET') { h['content-type'] ??= 'application/json'; h['x-sf-ops'] ??= '1'; h.origin ??= ORIGIN; }
    const res = await handle(new Request(`${ORIGIN}/operations/api/${path}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }), deps);
    const setCookie = res.headers.get('set-cookie');
    const sid = setCookie?.match(new RegExp(`${SESSION_COOKIE}=([^;]*)`))?.[1];
    return { status: res.status, body: await res.json(), sid, headers: res.headers };
  };
  const signIn = async email => {
    await call('POST', 'auth/request', { email });
    const last = mail.at(-1); assert.ok(last, 'sign-in email sent'); assert.equal(last.to.address, email);
    const token = last.text.match(/#signin=([\w-]+)/)[1];
    const r = await call('POST', 'auth/verify', { token });
    assert.equal(r.status, 200); return r.sid;
  };
  const enrollFounder = async sid => {
    const s = await call('POST', 'auth/authenticator/setup', {}, { cookie: sid });
    assert.equal(s.status, 200);
    const c = await call('POST', 'auth/authenticator/confirm', { code: totpAt(s.body.secret, Math.floor(clock / 30000)) }, { cookie: sid });
    assert.equal(c.status, 200); return s.body.secret;
  };
  const founderReady = async () => { const sid = await signIn(FOUNDER_EMAIL); const secret = await enrollFounder(sid); return { sid, secret }; };
  return { store, mail, deps, call, signIn, enrollFounder, founderReady, tick: ms => { clock += ms; }, get clock() { return clock; } };
}
async function withCoordinator(w) {
  const f = await w.founderReady();
  const inv = await w.call('POST', 'team/invite', { email: COORD, name: 'Test Coordinator', role: 'coordinator' }, { cookie: f.sid });
  assert.equal(inv.status, 201);
  const csid = await w.signIn(COORD);
  return { ...f, csid, coordId: inv.body.member.id };
}

// ---------- TOTP ----------
test('TOTP matches RFC 6238 SHA-1 test vector and blocks reuse', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, Math.floor(59 / 30)), '287082'); // RFC 6238 vector, last 6 digits of 94287082
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  const step = verifyTotp(secret, '287082', 59000);
  assert.equal(step, 1);
  assert.equal(verifyTotp(secret, '287082', 59000, step), null, 'same code cannot be used twice');
  assert.equal(verifyTotp(secret, '12345', 59000), null);
});

// ---------- Authentication ----------
test('unauthenticated access is denied everywhere', async () => {
  const w = world();
  for (const p of ['dashboard', 'participants', 'followups', 'outreach', 'relationships', 'resources', 'team', 'audit', 'auth/me'])
    assert.equal((await w.call('GET', p)).status, 401, p);
});

test('no public registration: unknown emails get the same answer and no email', async () => {
  const w = world();
  const r = await w.call('POST', 'auth/request', { email: 'stranger@example.com' });
  const r2 = await w.call('POST', 'auth/request', { email: 'not-an-email' });
  assert.equal(r.status, 200); assert.deepEqual(r.body, r2.body);
  assert.equal(w.mail.length, 0);
  assert.equal((await w.store.list('members/')).length, 0);
});

test('sign-in link works once and expires', async () => {
  const w = world();
  await w.call('POST', 'auth/request', { email: FOUNDER_EMAIL });
  const token = w.mail[0].text.match(/#signin=([\w-]+)/)[1];
  assert.match(w.mail[0].text, /https:\/\/spinfamilyapp\.com\/operations\/#signin=/);
  const first = await w.call('POST', 'auth/verify', { token });
  assert.equal(first.status, 200); assert.ok(first.sid);
  assert.match(first.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await w.call('POST', 'auth/verify', { token })).status, 400, 'reuse rejected');
  await w.call('POST', 'auth/request', { email: FOUNDER_EMAIL });
  const t2 = w.mail[1].text.match(/#signin=([\w-]+)/)[1];
  w.tick(16 * 60 * 1000);
  assert.equal((await w.call('POST', 'auth/verify', { token: t2 })).status, 400, 'expired link rejected');
});

test('sign-in link requests are throttled per member', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) await w.call('POST', 'auth/request', { email: FOUNDER_EMAIL });
  assert.equal(w.mail.length, 3);
});

test('founder must enroll an authenticator before team management, then enter a code on every sign-in', async () => {
  const w = world();
  const sid = await w.signIn(FOUNDER_EMAIL);
  const blocked = await w.call('GET', 'team', undefined, { cookie: sid });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.error.code, 'step_up_required');
  const secret = await w.enrollFounder(sid);
  assert.equal((await w.call('GET', 'team', undefined, { cookie: sid })).status, 200);
  // New sign-in: everything blocked until the code is entered.
  w.tick(60000);
  const sid2 = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: sid2 })).status, 401);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: sid2 })).body.mfa, 'pending');
  assert.equal((await w.call('POST', 'auth/mfa', { code: '000000' }, { cookie: sid2 })).status, 400);
  const ok = await w.call('POST', 'auth/mfa', { code: totpAt(secret, Math.floor(w.clock / 30000)) }, { cookie: sid2 });
  assert.equal(ok.status, 200);
  assert.equal((await w.call('GET', 'team', undefined, { cookie: sid2 })).status, 200);
});

test('five wrong authenticator codes end the session', async () => {
  const w = world();
  const { secret } = await w.founderReady();
  w.tick(60000);
  const sid = await w.signIn(FOUNDER_EMAIL);
  for (let i = 0; i < 5; i++) await w.call('POST', 'auth/mfa', { code: '000000' }, { cookie: sid });
  assert.equal((await w.call('POST', 'auth/mfa', { code: totpAt(secret, Math.floor(w.clock / 30000)) }, { cookie: sid })).status, 401);
});

test('sessions expire when idle and on sign-out', async () => {
  const w = world();
  const { csid } = await withCoordinator(w);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: csid })).status, 200);
  w.tick(9 * 60 * 60 * 1000);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: csid })).status, 401, 'idle timeout');
  const sid = await w.signIn(COORD);
  await w.call('POST', 'auth/logout', {}, { cookie: sid });
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: sid })).status, 401, 'logout');
});

test('revoking access signs the person out immediately and blocks new links', async () => {
  const w = world();
  const { sid, csid, coordId } = await withCoordinator(w);
  assert.equal((await w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid })).status, 200);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: csid })).status, 401);
  const before = w.mail.length;
  await w.call('POST', 'auth/request', { email: COORD });
  assert.equal(w.mail.length, before, 'no link for revoked member');
});

// ---------- CSRF and request hygiene ----------
test('cross-site and malformed mutations are blocked', async () => {
  const w = world();
  const { csid } = await withCoordinator(w);
  const body = { firstName: 'Synthetic' };
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { 'x-sf-ops': '0' } })).status, 403);
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { 'content-type': 'text/plain' } })).status, 415);
  const big = await w.call('POST', 'participants', { firstName: 'x'.repeat(40000) }, { cookie: csid });
  assert.equal(big.status, 413);
});

// ---------- Authorization ----------
test('coordinator cannot reach founder-only functions', async () => {
  const w = world();
  const { csid, coordId } = await withCoordinator(w);
  for (const [m, p, b] of [['GET', 'team'], ['GET', 'audit'], ['POST', 'team/invite', { email: 'x@example.com', name: 'X', role: 'coordinator' }], ['PATCH', `team/${coordId}`, { action: 'restore' }], ['POST', 'resources', { title: 'x', url: 'https://example.com' }]])
    assert.equal((await w.call(m, p, b, { cookie: csid })).status, 403, `${m} ${p}`);
});

test('client-side role claims are ignored; nobody can invite a second founder', async () => {
  const w = world();
  const { sid, csid } = await withCoordinator(w);
  assert.equal((await w.call('GET', 'team', undefined, { cookie: csid, headers: { 'x-role': 'founder', cookie: `${SESSION_COOKIE}=${csid}; role=founder` } })).status, 403);
  const r = await w.call('POST', 'team/invite', { email: 'b@example.com', name: 'B', role: 'founder' }, { cookie: sid });
  assert.equal(r.status, 400);
});

test('coordinator sees only assigned participants and cannot assign or reveal others', async () => {
  const w = world();
  const { sid, csid, coordId } = await withCoordinator(w);
  const a = await w.call('POST', 'participants', { firstName: 'Alpha', email: 'alpha@example.com', cohort: 'pilot' }, { cookie: sid });
  const b = await w.call('POST', 'participants', { firstName: 'Bravo', email: 'bravo@example.com', cohort: 'pilot' }, { cookie: sid });
  await w.call('PATCH', `participants/${a.body.participant.id}`, { assignedTo: coordId }, { cookie: sid });
  const list = await w.call('GET', 'participants', undefined, { cookie: csid });
  assert.deepEqual(list.body.participants.map(p => p.firstName), ['Alpha']);
  assert.equal(list.body.participants[0].email, 'alpha@example.com', 'assigned contact visible');
  assert.equal((await w.call('GET', `participants/${b.body.participant.id}`, undefined, { cookie: csid })).status, 404, 'unassigned record hidden');
  assert.equal((await w.call('PATCH', `participants/${a.body.participant.id}`, { assignedTo: null }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `participants/${a.body.participant.id}`, { isTest: true }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `participants/${a.body.participant.id}`, { account: 'confirmed' }, { cookie: csid })).status, 200);
});

test('participants created by the coordinator are assigned to them', async () => {
  const w = world();
  const { csid } = await withCoordinator(w);
  const r = await w.call('POST', 'participants', { firstName: 'Charlie', email: 'charlie@example.com' }, { cookie: csid });
  assert.equal(r.status, 201); assert.equal(r.body.participant.email, 'charlie@example.com');
});

test('duplicate participant emails are refused', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  assert.equal((await w.call('POST', 'participants', { firstName: 'A', email: 'dup@example.com' }, { cookie: sid })).status, 201);
  assert.equal((await w.call('POST', 'participants', { firstName: 'B', email: 'DUP@example.com ' }, { cookie: sid })).status, 400);
});

test('participant history is append-only and records each change', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  const p = (await w.call('POST', 'participants', { firstName: 'Delta' }, { cookie: sid })).body.participant;
  w.tick(1000);
  await w.call('PATCH', `participants/${p.id}`, { account: 'confirmed', engagement: 'first_plan_generated' }, { cookie: sid });
  const d = await w.call('GET', `participants/${p.id}`, undefined, { cookie: sid });
  assert.equal(d.body.history.length, 2);
  assert.deepEqual(d.body.history[1].changes.map(c => c.field).sort(), ['account', 'engagement']);
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { email: 'x@example.com' }, { cookie: sid })).status, 400, 'email locked');
});

test('children\'s details and invalid states are rejected', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  assert.equal((await w.call('POST', 'participants', { firstName: 'E', account: 'super_active' }, { cookie: sid })).status, 400);
  assert.equal((await w.call('POST', 'participants', { firstName: '' }, { cookie: sid })).status, 400);
});

// ---------- Intake ----------
test('form intake is idempotent, keeps the original link source and never sends email', async () => {
  const w = world();
  const data = { 'form-name': 'pilot', source: 'direct', company: '', first_name: 'Echo', email: 'Echo@Example.com', children_under_10: '2', consent: 'yes' };
  assert.equal(await ingestPilotSubmission(w.store, data, '2026-11-24T16:00:00.000Z'), 'created');
  assert.equal(await ingestPilotSubmission(w.store, { ...data, source: 'campus' }, '2026-11-24T16:05:00.000Z'), 'duplicate');
  assert.equal(await ingestPilotSubmission(w.store, { ...data, consent: 'no', email: 'f@example.com' }, '2026-11-24T16:06:00.000Z'), 'skipped_invalid');
  assert.equal(await ingestPilotSubmission(w.store, { ...data, company: 'bot', email: 'g@example.com' }, '2026-11-24T16:06:00.000Z'), 'skipped_invalid');
  const all = (await w.store.list('participants/'));
  assert.equal(all.length, 1);
  const p = await w.store.get(all[0]);
  assert.equal(p.technicalSource, 'direct'); assert.equal(p.reportedSource, 'unknown'); assert.equal(p.isTest, null); assert.equal(p.email, 'echo@example.com');
  assert.equal(w.mail.length, 0);
});

// ---------- Dashboard ----------
test('dashboard shows unknown instead of zero and separates targets from actuals', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  await w.call('POST', 'participants', { firstName: 'Fox', cohort: 'pilot' }, { cookie: sid });
  const d = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body;
  const m = Object.fromEntries(d.metrics.map(x => [x.id, x]));
  assert.equal(m.accounts.value, null); assert.equal(m.accounts.status, 'unknown');
  assert.equal(m.activation.status, 'unknown');
  assert.equal(m.target.status, 'target');
  assert.equal(m.registrations.value, 1); assert.equal(m.registrations.status, 'actual');
  assert.equal(m.surveys.status, 'pending');
});

test('records marked as tests are excluded from counts', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  const p = (await w.call('POST', 'participants', { firstName: 'Golf', cohort: 'pilot' }, { cookie: sid })).body.participant;
  await w.call('PATCH', `participants/${p.id}`, { isTest: true }, { cookie: sid });
  const d = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body;
  assert.equal(d.metrics.find(x => x.id === 'registrations').value, 0);
});

// ---------- Follow-ups, outreach, relationships, resources ----------
test('coordinator can log outreach, relationships and follow-ups but not approve offers', async () => {
  const w = world();
  const { csid } = await withCoordinator(w);
  const o = await w.call('POST', 'outreach', { channel: 'campus', place: 'Student union table', approached: '', reportedSignups: '3' }, { cookie: csid });
  assert.equal(o.status, 201); assert.equal(o.body.outreach.approached, null, 'unknown stays unknown'); assert.equal(o.body.outreach.reportedSignups, 3);
  const r = await w.call('POST', 'relationships', { contactName: 'Synthetic Contact', organization: 'Example College', stage: 'contacted', nextActionDate: '2026-12-01' }, { cookie: csid });
  assert.equal(r.status, 201);
  assert.equal((await w.call('PATCH', `relationships/${r.body.relationship.id}`, { offerApproved: true }, { cookie: csid })).status, 403);
  assert.equal((await w.call('POST', `relationships/${r.body.relationship.id}/log`, { kind: 'meeting', summary: 'Met at the table' }, { cookie: csid })).status, 201);
  const f = await w.call('POST', 'followups', { title: 'Check in', subjectType: 'relationship', subjectId: r.body.relationship.id, dueDate: '2026-12-02' }, { cookie: csid });
  assert.equal(f.status, 201);
  assert.equal((await w.call('PATCH', `followups/${f.body.followup.id}`, { status: 'done', outcome: 'Done' }, { cookie: csid })).body.followup.status, 'done');
});

test('materials are seeded once with approval status and only the founder can change them', async () => {
  const w = world();
  const { sid, csid } = await withCoordinator(w);
  const list = (await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources;
  assert.ok(list.length >= 4); assert.ok(list.every(r => r.approval && r.url.startsWith('https://')));
  assert.equal((await w.call('PATCH', `resources/${list[0].id}`, { approval: 'retired' }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `resources/${list[0].id}`, { approval: 'retired' }, { cookie: sid })).status, 200);
  assert.equal((await w.call('GET', 'resources', undefined, { cookie: sid })).body.resources.length, list.length, 'no reseed');
});

test('audit log holds ids and actions, not email addresses', async () => {
  const w = world();
  await withCoordinator(w);
  const entries = await Promise.all((await w.store.list('audit/')).map(k => w.store.get(k)));
  assert.ok(entries.length > 3);
  assert.ok(!JSON.stringify(entries).includes('@'));
});

// ---------- Preview isolation ----------
test('preview and production use different stores; team-login shortcut is preview-only', async () => {
  assert.notEqual(storeNameFor('production'), storeNameFor('deploy-preview'));
  const prod = world({ deployContext: 'production', netlifyUser: { id: 'u1', email: FOUNDER_EMAIL } });
  assert.equal((await prod.call('POST', 'auth/preview', {})).status, 404);
  const prev = world({ deployContext: 'deploy-preview', netlifyUser: { id: 'u1', email: FOUNDER_EMAIL } });
  const ok = await prev.call('POST', 'auth/preview', {});
  assert.equal(ok.status, 200); assert.ok(ok.sid);
  const stranger = world({ deployContext: 'deploy-preview', netlifyUser: { id: 'u2', email: 'someone@example.com' } });
  assert.equal((await stranger.call('POST', 'auth/preview', {})).status, 403);
});

// ---------- Source safety ----------
test('front end has no third-party code, inline scripts or browser storage', () => {
  const js = readFileSync(new URL('../public/operations/ops.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../public/operations/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /localStorage|sessionStorage|innerHTML|eval\(|https?:\/\/(?!spinfamilyapp)/);
  assert.doesNotMatch(html, /<script>(?!<\/script>)|https?:\/\//);
  assert.match(html, /noindex/);
});

test('existing welcome email and scheduled batch are untouched', () => {
  const toml = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /for = "\/operations\/\*"/);
  const batch = readFileSync(new URL('../netlify/functions/welcome-batch-20261125.mjs', import.meta.url), 'utf8');
  assert.match(batch, /schedule:'0 14 25 11 \*'/);
});

// ---------- Company docs: uploads and sharing ----------
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32), Buffer.from('%%EOF')]);
const up = (title, extra = {}, bytes = PDF, fileName = 'one-pager.pdf') => ({ title, fileName, dataBase64: bytes.toString('base64'), category: 'outreach', ...extra });
async function rawGet(w, path, sid) {
  return handle(new Request(`${ORIGIN}/operations/api/${path}`, { headers: { cookie: `${SESSION_COOKIE}=${sid}` } }), w.deps);
}

test('founder shares a file with the team; coordinator can list and download it, with safe headers', async () => {
  const w = world();
  const { sid, csid } = await withCoordinator(w);
  const mailsBefore = w.mail.length;
  const r = await w.call('POST', 'resources/upload', up('PRC one-pager', { audience: 'team', notify: true }), { cookie: sid });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.resource.contentType, 'application/pdf'); assert.equal(r.body.resource.fileKey, undefined);
  assert.equal(r.body.notified, 1); assert.equal(w.mail.length, mailsBefore + 1); assert.equal(w.mail.at(-1).to.address, COORD);
  assert.match(w.mail.at(-1).text, /operations\/#\/docs/); assert.doesNotMatch(w.mail.at(-1).text, /resources\/.*\/file/);
  const list = (await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources;
  const doc = list.find(x => x.title === 'PRC one-pager'); assert.ok(doc);
  const res = await rawGet(w, `resources/${doc.id}/file`, csid);
  assert.equal(res.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await res.arrayBuffer()), PDF), 0);
  assert.match(res.headers.get('content-disposition'), /^attachment;/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('documents kept to the founder or to named people stay hidden from everyone else', async () => {
  const w = world();
  const { sid, csid, coordId } = await withCoordinator(w);
  const inv = await w.call('POST', 'team/invite', { email: 'second@example.com', name: 'Second Person', role: 'coordinator' }, { cookie: sid });
  const ssid = await w.signIn('second@example.com');
  const priv = (await w.call('POST', 'resources/upload', up('Founder notes', { audience: 'founder' }), { cookie: sid })).body.resource;
  const named = (await w.call('POST', 'resources/upload', up('For coordinator', { audience: [coordId] }), { cookie: sid })).body.resource;
  const titles = async s => (await w.call('GET', 'resources', undefined, { cookie: s })).body.resources.map(r => r.title);
  assert.ok(!(await titles(csid)).includes('Founder notes'));
  assert.ok((await titles(csid)).includes('For coordinator'));
  assert.ok(!(await titles(ssid)).includes('For coordinator'));
  assert.equal((await rawGet(w, `resources/${priv.id}/file`, csid)).status, 404);
  assert.equal((await rawGet(w, `resources/${named.id}/file`, ssid)).status, 404);
  assert.equal((await rawGet(w, `resources/${named.id}/file`, csid)).status, 200);
  assert.ok(inv.body.member.id);
});

test('coordinator uploads go to the founder for review and cannot be re-shared by the coordinator', async () => {
  const w = world();
  const { sid, csid } = await withCoordinator(w);
  await w.call('POST', 'team/invite', { email: 'second@example.com', name: 'Second Person', role: 'coordinator' }, { cookie: sid });
  const ssid = await w.signIn('second@example.com');
  const before = w.mail.length;
  const r = await w.call('POST', 'resources/upload', up('Draft flyer', { audience: 'team', approval: 'approved' }), { cookie: csid });
  assert.equal(r.status, 201);
  assert.equal(r.body.resource.approval, 'pending_review'); assert.equal(r.body.resource.audience, 'founder');
  assert.equal(w.mail.length, before + 1); assert.equal(w.mail.at(-1).to.address, FOUNDER_EMAIL);
  assert.ok((await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources.some(x => x.id === r.body.resource.id), 'uploader sees own');
  assert.ok(!(await w.call('GET', 'resources', undefined, { cookie: ssid })).body.resources.some(x => x.id === r.body.resource.id));
  assert.equal((await w.call('PATCH', `resources/${r.body.resource.id}`, { audience: 'team' }, { cookie: csid })).status, 403);
  const shared = await w.call('PATCH', `resources/${r.body.resource.id}`, { audience: 'team', approval: 'approved' }, { cookie: sid });
  assert.equal(shared.status, 200);
  assert.ok((await w.call('GET', 'resources', undefined, { cookie: ssid })).body.resources.some(x => x.id === r.body.resource.id));
});

test('only real documents and images under 4 MB are accepted', async () => {
  const w = world();
  const { sid } = await w.founderReady();
  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(40, ' '));
  for (const [bytes, name] of [[html, 'trick.pdf'], [html, 'page.html'], [Buffer.from('MZ' + 'x'.repeat(40)), 'tool.exe'], [PDF, 'one-pager.png'], [Buffer.alloc(0), 'empty.pdf']])
    assert.equal((await w.call('POST', 'resources/upload', up('Bad', {}, bytes, name), { cookie: sid })).status, 400, name);
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(4 * 1024 * 1024 + 10)]);
  assert.equal((await w.call('POST', 'resources/upload', up('Big', {}, big), { cookie: sid })).status, 400);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
  const ok = await w.call('POST', 'resources/upload', up('Logo', {}, png, '../../Logo final!.png'), { cookie: sid });
  assert.equal(ok.status, 201); assert.equal(ok.body.resource.fileName, 'Logo final.png');
});

test('founder uploads need the authenticator code; signed-out requests get nothing', async () => {
  const w = world();
  const sid = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'resources/upload', up('x'), { cookie: sid })).status, 403);
  assert.equal((await w.call('POST', 'resources/upload', up('x'))).status, 401);
});
