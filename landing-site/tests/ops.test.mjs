// SF-PILOT-OPS-001 workspace tests against a real PostgreSQL server with several connections
// (tests/helpers/harness.mjs). Synthetic records only. Race tests with barriers: ops-r2.test.mjs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FOUNDER_EMAIL } from '../lib/ops/core.mjs';
import { ingestPilotSubmission, PILOT_CONSENT_TEXT } from '../lib/ops/records.mjs';
import { runtimeFacts, secretsFor } from '../lib/ops/runtime.mjs';
import { SITE_ID } from '../lib/pilot-welcome.mjs';
import { totpAt, verifyTotp, base32Decode, base32Encode } from '../lib/ops/security.mjs';
import { startDatabase, world as makeWorld, team, COORD, BOOTSTRAP, RECOVERY, FORM, reviewedParticipant } from './helpers/harness.mjs';

let pgdb, db;
before(async () => { pgdb = await startDatabase(); db = pgdb.db; });
after(async () => { await pgdb?.stop(); });
beforeEach(async () => { await pgdb.reset(); });
const world = (opts) => makeWorld(db, opts);

// ---------- TOTP ----------
test('TOTP matches RFC 6238 SHA-1 test vector and blocks reuse', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totpAt(secret, 1), '287082');
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  const step = verifyTotp(secret, '287082', 59000);
  assert.equal(step, 1);
  assert.equal(verifyTotp(secret, '287082', 59000, step), null);
});

// ---------- Authentication ----------
test('unauthenticated access is denied everywhere', async () => {
  const w = world();
  for (const p of ['dashboard', 'participants', 'followups', 'outreach', 'relationships', 'resources', 'team', 'audit', 'approvals', 'content', 'research', 'auth/me'])
    assert.equal((await w.call('GET', p)).status, 401, p);
});

test('no public registration: unknown emails get the same answer and no email', async () => {
  const w = world();
  const r = await w.call('POST', 'auth/request', { email: 'stranger@example.com' });
  const r2 = await w.call('POST', 'auth/request', { email: 'not-an-email' });
  assert.equal(r.status, 200); assert.deepEqual(r.body, r2.body);
  assert.equal(w.mail.length, 0);
  assert.equal((await db.sql`SELECT count(*)::int n FROM members`)[0].n, 0);
});

test('sign-in link works once and expires', async () => {
  const w = world();
  const token = await w.requestLink(FOUNDER_EMAIL);
  assert.match(w.mail[0].text, /https:\/\/spinfamilyapp\.com\/operations\/#signin=/);
  const first = await w.call('POST', 'auth/verify', { token });
  assert.equal(first.status, 200);
  assert.match(first.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await w.call('POST', 'auth/verify', { token })).status, 400);
  const t2 = await w.requestLink(FOUNDER_EMAIL);
  w.tick(16 * 60 * 1000);
  assert.equal((await w.call('POST', 'auth/verify', { token: t2 })).status, 400);
});

test('IR-01: parallel link use and parallel link requests are atomic', async () => {
  const w = world();
  const token = await w.requestLink(FOUNDER_EMAIL);
  const both = await Promise.all([w.call('POST', 'auth/verify', { token }), w.call('POST', 'auth/verify', { token })]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 400]);
  w.tick(16 * 60 * 1000);
  const before = w.mail.length;
  await Promise.all(Array.from({ length: 10 }, () => w.call('POST', 'auth/request', { email: FOUNDER_EMAIL })));
  assert.equal(w.mail.length - before, 3, 'throttle holds under parallel requests');
});

test('IR-07/R2-01: founder setup needs this deploy\'s one-time bootstrap code; not the recovery code; locked without it', async () => {
  const w = world();
  const sid = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'auth/authenticator/setup', {}, { cookie: sid })).status, 403);
  assert.equal((await w.call('POST', 'auth/authenticator/setup', { enrollmentCode: 'wrong' }, { cookie: sid })).status, 403);
  assert.equal((await w.call('POST', 'auth/authenticator/setup', { enrollmentCode: RECOVERY }, { cookie: sid })).status, 403, 'the recovery code is not a setup code');
  assert.equal((await w.call('POST', 'auth/authenticator/setup', { enrollmentCode: BOOTSTRAP }, { cookie: sid })).status, 200);
  await pgdb.reset();
  const locked = world({ secrets: { bootstrap: null, recovery: null } });
  const sid2 = await locked.signIn(FOUNDER_EMAIL);
  const r = await locked.call('POST', 'auth/authenticator/setup', { enrollmentCode: 'anything' }, { cookie: sid2 });
  assert.equal(r.status, 403); assert.match(r.body.error.message, /locked until the setup code is set/);
  await pgdb.reset();
  const same = world({ secrets: secretsFor({ isProduction: true }, k => ({ OPS_FOUNDER_BOOTSTRAP_CODE: 'x', OPS_FOUNDER_RECOVERY_CODE: 'x' })[k]) });
  const sid3 = await same.signIn(FOUNDER_EMAIL);
  assert.equal((await same.call('POST', 'auth/authenticator/setup', { enrollmentCode: 'x' }, { cookie: sid3 })).status, 403, 'identical setup and recovery codes are refused');
});

test('IR-07: everyone needs an authenticator before seeing any data, coordinators included', async () => {
  const w = world();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  await w.call('POST', 'team/invite', { email: COORD, name: 'C', role: 'coordinator' }, { cookie: sid });
  const csid = await w.signIn(COORD);
  const r = await w.call('GET', 'participants', undefined, { cookie: csid });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'authenticator_required');
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: csid })).body.needsAuthenticator, true);
  await w.enroll(csid, false);
  assert.equal((await w.call('GET', 'participants', undefined, { cookie: csid })).status, 200);
});

test('a code is needed at every sign-in; the same code cannot be used by two sessions (IR-01)', async () => {
  const w = world();
  const { secret } = await w.ready(FOUNDER_EMAIL);
  w.tick(60000);
  const a = await w.signIn(FOUNDER_EMAIL), b = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: a })).status, 401);
  const code = w.code(secret);
  const both = await Promise.all([w.call('POST', 'auth/mfa', { code }, { cookie: a }), w.call('POST', 'auth/mfa', { code }, { cookie: b })]);
  assert.deepEqual(both.map(r => r.status).sort(), [200, 400]);
});

test('IR-01: five wrong codes end the session even when sent in parallel', async () => {
  const w = world();
  const { secret } = await w.ready(FOUNDER_EMAIL);
  w.tick(60000);
  const sid = await w.signIn(FOUNDER_EMAIL);
  await Promise.all(Array.from({ length: 5 }, () => w.call('POST', 'auth/mfa', { code: '000000' }, { cookie: sid })));
  assert.equal((await w.call('POST', 'auth/mfa', { code: w.code(secret) }, { cookie: sid })).status, 401);
});

test('R2-01: founder recovery needs a fresh link plus the one-time recovery code; ends other sessions and links; each code works once', async () => {
  const w = world();
  const { sid: old } = await w.ready(FOUNDER_EMAIL);
  w.tick(60000);
  const outstanding = await w.requestLink(FOUNDER_EMAIL);
  const sid = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'auth/authenticator/recover', { enrollmentCode: BOOTSTRAP }, { cookie: sid })).status, 403, 'the bootstrap code cannot recover');
  assert.equal((await w.call('POST', 'auth/authenticator/recover', { enrollmentCode: RECOVERY }, { cookie: sid })).status, 200);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: old })).status, 401, 'other sessions ended');
  assert.equal((await w.call('POST', 'auth/verify', { token: outstanding })).status, 400, 'outstanding links cancelled');
  const me = (await w.call('GET', 'auth/me', undefined, { cookie: sid })).body;
  assert.equal(me.founderEnrollmentCodeRequired, false, 'recovered session sets up without the bootstrap code');
  const s = await w.setup(sid, false);
  assert.equal((await w.call('POST', 'auth/authenticator/confirm', { setupId: s.setupId, code: w.code(s.secret) }, { cookie: sid })).status, 200);
  assert.equal((await w.call('GET', 'team', undefined, { cookie: sid })).status, 200);
  assert.ok(w.mail.some(m => /authenticator was reset/.test(m.subject)), 'founder is told by email');
  w.tick(16 * 60000);
  const sid2 = await w.signIn(FOUNDER_EMAIL);
  const again = await w.call('POST', 'auth/authenticator/recover', { enrollmentCode: RECOVERY }, { cookie: sid2 });
  assert.equal(again.status, 403); assert.equal(again.body.error.code, 'recovery_used');
});

test('sessions expire when idle; logout cannot be undone by a later request (IR-01)', async () => {
  const w = world();
  const { csid } = await team(w);
  w.tick(9 * 60 * 60 * 1000);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: csid })).status, 401);
  w.tick(60000);
  const sid = await w.signIn(COORD);
  await Promise.all([w.call('POST', 'auth/logout', {}, { cookie: sid }), w.call('GET', 'auth/me', undefined, { cookie: sid })]);
  w.tick(120000);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: sid })).status, 401);
});

test('IR-01: revoking cancels links already sent, kills sessions, and restoring does not revive old links', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  w.tick(16 * 60 * 1000);
  const pending = await w.requestLink(COORD);
  assert.equal((await w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid })).status, 200);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: csid })).status, 401);
  assert.equal((await w.call('POST', 'auth/verify', { token: pending })).status, 400);
  await w.call('PATCH', `team/${coordId}`, { action: 'restore' }, { cookie: sid });
  assert.equal((await w.call('POST', 'auth/verify', { token: pending })).status, 400, 'old link stays dead after restore');
});

test('IR-01: a session started in the same instant as a revocation does not survive', async () => {
  const w = world();
  const { sid, coordId } = await team(w);
  w.tick(16 * 60 * 1000);
  const token = await w.requestLink(COORD);
  const [v] = await Promise.all([w.call('POST', 'auth/verify', { token }), w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid })]);
  if (v.status === 200) assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: v.sid })).status, 401);
});

test('founder can move a teammate to a company email; old sessions and links end', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  const r = await w.call('PATCH', `team/${coordId}`, { email: 'new-address@example.com' }, { cookie: sid });
  assert.equal(r.status, 200); assert.equal(r.body.member.email, 'new-address@example.com');
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: csid })).status, 401);
  w.tick(1000);
  const before = w.mail.length;
  await w.call('POST', 'auth/request', { email: COORD });
  assert.equal(w.mail.length, before, 'old address gets nothing');
});

// ---------- CSRF and request hygiene ----------
test('cross-site and malformed mutations are blocked', async () => {
  const w = world();
  const { csid } = await team(w);
  const body = { firstName: 'Synthetic' };
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { 'x-sf-ops': '0' } })).status, 403);
  assert.equal((await w.call('POST', 'participants', body, { cookie: csid, headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await w.call('POST', 'participants', { firstName: 'x'.repeat(40000) }, { cookie: csid })).status, 413);
});

// ---------- Authorization ----------
test('coordinator cannot reach founder-only functions; client role claims are ignored', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  for (const [m, p, b] of [['GET', 'team'], ['GET', 'audit'], ['POST', 'team/invite', { email: 'x@example.com', name: 'X', role: 'coordinator' }], ['PATCH', `team/${coordId}`, { action: 'restore' }], ['POST', 'resources', { title: 'x', url: 'https://example.com' }], ['POST', 'participants/import', { source: 'founder_records', exportRef: 'x', exportedAt: '2026-11-24', expectedCount: 1, consentEvidence: 'x', records: [{ firstName: 'A', email: 'a@example.com', consent: { value: 'yes', version: 'v' } }] }], ['POST', 'participants/backfill', { receiptIds: [] }], ['POST', 'research/cohorts', { name: 'X' }]])
    assert.equal((await w.call(m, p, b, { cookie: csid })).status, 403, `${m} ${p}`);
  assert.equal((await w.call('GET', 'team', undefined, { cookie: csid, headers: { 'x-role': 'founder' } })).status, 403);
  assert.equal((await w.call('POST', 'team/invite', { email: 'b@example.com', name: 'B', role: 'founder' }, { cookie: sid })).status, 400);
});

test('coordinator sees only assigned participants and cannot assign or reveal others', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  const a = (await w.call('POST', 'participants', { firstName: 'Alpha', email: 'alpha@example.com', cohort: 'pilot' }, { cookie: sid })).body.participant;
  const b = (await w.call('POST', 'participants', { firstName: 'Bravo', email: 'bravo@example.com', cohort: 'pilot' }, { cookie: sid })).body.participant;
  await w.call('PATCH', `participants/${a.id}`, { assignedTo: coordId, version: a.version }, { cookie: sid });
  const list = await w.call('GET', 'participants', undefined, { cookie: csid });
  assert.deepEqual(list.body.participants.map(p => p.firstName), ['Alpha']);
  assert.equal(list.body.participants[0].email, 'alpha@example.com');
  assert.equal((await w.call('GET', `participants/${b.id}`, undefined, { cookie: csid })).status, 404);
  const cur = list.body.participants[0];
  assert.equal((await w.call('PATCH', `participants/${a.id}`, { assignedTo: null, version: cur.version }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `participants/${a.id}`, { isTest: true, version: cur.version }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `participants/${a.id}`, { notes: 'Called', version: cur.version }, { cookie: csid })).status, 200);
});

test('IR-05: a stale edit cannot undo a newer reassignment, and a reassigned record is out of reach', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  let p = (await w.call('POST', 'participants', { firstName: 'Delta', email: 'delta@example.com', cohort: 'pilot' }, { cookie: sid })).body.participant;
  p = (await w.call('PATCH', `participants/${p.id}`, { assignedTo: coordId, version: p.version }, { cookie: sid })).body.participant;
  const coordView = (await w.call('GET', `participants/${p.id}`, undefined, { cookie: csid })).body.participant;
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { assignedTo: null, version: p.version }, { cookie: sid })).status, 200);
  const stale = await w.call('PATCH', `participants/${p.id}`, { notes: 'from old screen', version: coordView.version }, { cookie: csid });
  assert.ok([404, 409].includes(stale.status));
  const now = (await w.call('GET', `participants/${p.id}`, undefined, { cookie: sid })).body.participant;
  assert.equal(now.assignedTo, null); assert.equal(now.notes, '');
  const v = now.version;
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { notes: 'tab 1', version: v }, { cookie: sid })).status, 200);
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { notes: 'tab 2', version: v }, { cookie: sid })).status, 409);
});

test('IR-05: the assignee on create must be on the team', async () => {
  const w = world();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'participants', { firstName: 'Echo', assignedTo: 'm_nobody' }, { cookie: sid })).status, 400);
});

test('IR-03: the coordinator cannot inflate verified numbers', async () => {
  const w = world();
  const { sid, csid } = await team(w);
  let p = (await w.call('POST', 'participants', { firstName: 'Fox', email: 'fox@example.com', cohort: 'pilot' }, { cookie: csid })).body.participant;
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { cohort: 'beta', version: p.version }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { account: 'confirmed', verify: { account: true }, evidenceNote: 'trust me', version: p.version }, { cookie: csid })).status, 403);
  p = (await w.call('PATCH', `participants/${p.id}`, { account: 'confirmed', engagement: 'repeat_use_observed', version: p.version }, { cookie: csid })).body.participant;
  assert.equal(p.verified.account, false);
  let m = Object.fromEntries((await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.metrics.map(x => [x.id, x]));
  assert.equal(m.accounts.value, null); assert.equal(m.accounts.status, 'unknown'); assert.match(m.accounts.definition, /1 more reported/);
  assert.equal(m.registrations.value, 0, 'hand-added records are not registrations');
  assert.equal((await w.call('PATCH', `participants/${p.id}`, { verify: { account: true }, version: p.version }, { cookie: sid })).status, 400, 'evidence note required');
  p = (await w.call('PATCH', `participants/${p.id}`, { verify: { account: true }, evidenceNote: 'Checked Netlify Identity', version: p.version }, { cookie: sid })).body.participant;
  assert.equal(p.verified.account, true);
  m = Object.fromEntries((await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.metrics.map(x => [x.id, x]));
  assert.equal(m.accounts.value, 1); assert.equal(m.repeat.value, null, 'repeat use still only reported');
  const cv = (await w.call('GET', `participants/${p.id}`, undefined, { cookie: csid })).body.participant;
  p = (await w.call('PATCH', `participants/${p.id}`, { account: 'confirmation_pending', version: cv.version }, { cookie: csid })).body.participant;
  assert.equal(p.verified.account, false);
});

test('IR-03/IR-09: counts are marked incomplete until the backfill is done; unreviewed and test records are not counted', async () => {
  const w = world();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const base = { 'form-name': 'pilot', source: 'direct', company: '', children_under_10: '2', consent: 'yes' };
  await ingestPilotSubmission(w.deps, { ...base, first_name: 'Golf', email: 'golf@example.com' }, '2026-11-24T16:00:00.000Z');
  await ingestPilotSubmission(w.deps, { ...base, first_name: 'Hotel', email: 'hotel@example.com' }, '2026-11-24T16:01:00.000Z');
  let d = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body;
  let reg = d.metrics.find(x => x.id === 'registrations');
  assert.equal(reg.value, 0); assert.equal(reg.status, 'incomplete'); assert.match(reg.definition, /2 waiting for review/); assert.match(reg.definition, /not been reconciled/);
  const list = (await w.call('GET', 'participants', undefined, { cookie: sid })).body.participants;
  for (const p of list) await w.call('PATCH', `participants/${p.id}`, { isTest: p.firstName === 'Hotel', version: p.version }, { cookie: sid });
  const beta = await w.call('POST', 'participants/import', { source: 'app_identity_export', exportRef: 'identity-users.csv', exportedAt: '2026-11-24', expectedCount: 1, records: [{ firstName: 'India', email: 'india@example.com', sourceSubmissionId: 'u-india' }] }, { cookie: sid });
  const forms = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'pilot-form.csv', exportedAt: '2026-11-24', expectedCount: 0, records: [] }, { cookie: sid });
  assert.equal(beta.body.reconciled, true); assert.equal(forms.body.reconciled, true);
  const india = (await w.call('GET', 'participants', undefined, { cookie: sid })).body.participants.find(p => p.firstName === 'India');
  await w.call('PATCH', `participants/${india.id}`, { isTest: false, version: india.version }, { cookie: sid });
  assert.equal((await w.call('POST', 'participants/backfill', { receiptIds: [beta.body.receiptId, forms.body.receiptId] }, { cookie: sid })).status, 200);
  d = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body;
  reg = d.metrics.find(x => x.id === 'registrations');
  assert.equal(reg.value, 1); assert.equal(reg.status, 'actual'); assert.deepEqual(reg.households, { known: 0, notRecorded: 1 });
  assert.equal(d.metrics.find(x => x.id === 'beta').value, 1);
});

// ---------- Intake (IR-04) ----------

test('IR-04: intake uses the strict welcome-email check', async () => {
  const w = world();
  for (const bad of [{ consent: 'no' }, { company: 'bot' }, { 'form-name': 'other' }, { children_under_10: '7' }, { email: 'a@example.com,b@example.com' }, { source: 'bad source!' }, { first_name: '<x>' }])
    assert.equal(await ingestPilotSubmission(w.deps, { ...FORM, ...bad }, '2026-11-24T16:00:00.000Z'), 'skipped_invalid', JSON.stringify(bad));
  assert.equal((await db.sql`SELECT count(*)::int n FROM participants`)[0].n, 0);
});
test('IR-04: duplicate deliveries, including parallel ones, make one record and one ledger row', async () => {
  const w = world();
  const meta = { submissionId: 'sub123', submittedAt: '2026-11-24T15:59:00Z' };
  const r = await Promise.all([1, 2, 3].map(() => ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z', meta)));
  assert.equal(r.filter(x => x === 'created').length, 1);
  assert.equal((await db.sql`SELECT count(*)::int n FROM participants`)[0].n, 1);
  const ledger = await db.sql`SELECT provenance, source_submission_id, consent, heard_from FROM pilot_intake_records`;
  assert.equal(ledger.length, 1); assert.equal(ledger[0].provenance, 'event_with_id'); assert.equal(ledger[0].source_submission_id, 'sub123');
  assert.equal(ledger[0].consent.purpose, 'pilot_email'); assert.equal(ledger[0].heard_from, 'An event');
  assert.equal(await ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:05:00.000Z', meta), 'duplicate_event');
  assert.equal((await db.sql`SELECT count(*)::int n FROM participant_history`)[0].n, 1, 'no new history for a redelivery');
  const p = (await db.sql`SELECT technical_source, reported_source, is_test, email FROM participants`)[0];
  assert.equal(p.technical_source, 'direct'); assert.equal(p.reported_source, 'unknown'); assert.equal(p.is_test, null); assert.equal(p.email, 'juliet@example.com');
  assert.equal(w.mail.length, 0, 'intake never sends email');
});
test('IR-04: events without an id are recorded as such, never given an invented id', async () => {
  const w = world();
  assert.equal(await ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z'), 'created');
  const l = (await db.sql`SELECT provenance, source_submission_id FROM pilot_intake_records`)[0];
  assert.equal(l.provenance, 'event_without_id'); assert.equal(l.source_submission_id, null);
});
test('IR-04: someone added by hand who then registers is promoted, keeping both sources', async () => {
  const w = world();
  const { csid } = await team(w);
  await w.call('POST', 'participants', { firstName: 'Juliet', email: 'juliet@example.com', reportedSource: 'lindsey' }, { cookie: csid });
  assert.equal(await ingestPilotSubmission(w.deps, { ...FORM, source: 'campus' }, '2026-11-24T16:00:00.000Z'), 'promoted_prospect');
  const p = (await db.sql`SELECT cohort, enrollment, technical_source, reported_source, assigned_to IS NOT NULL AS assigned FROM participants`)[0];
  assert.deepEqual({ ...p }, { cohort: 'pilot', enrollment: 'registration_received', technical_source: 'campus', reported_source: 'lindsey', assigned: true });
  assert.equal(await ingestPilotSubmission(w.deps, { ...FORM, source: 'instagram', heard_from: 'Social media' }, '2026-11-24T17:00:00.000Z'), 'linked_existing');
  assert.equal((await db.sql`SELECT technical_source FROM participants`)[0].technical_source, 'campus', 'first source kept');
});

test('IR-09/R2-03: founder import needs source ids and consent, writes ledger rows and a receipt, and links existing people', async () => {
  const w = world();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const consent = { value: 'yes', version: 'pilot-form:2026-11' };
  const base = { source: 'netlify_forms_export', exportRef: 'pilot-form-2026-11-24.csv', exportedAt: '2026-11-24', expectedCount: 2, consentEvidence: 'Archived form page, Drive' };
  assert.equal((await w.call('POST', 'participants/import', { ...base, records: [{ firstName: 'Kilo', email: 'kilo@example.com', consent }] }, { cookie: sid })).status, 400, 'source id required');
  assert.equal((await w.call('POST', 'participants/import', { ...base, records: [{ firstName: 'Kilo', email: 'kilo@example.com', sourceSubmissionId: 's1' }] }, { cookie: sid })).status, 400, 'consent required');
  const r = await w.call('POST', 'participants/import', { ...base, records: [
    { firstName: 'Kilo', email: 'kilo@example.com', source: 'direct', submittedAt: '2026-11-12T10:00:00Z', sourceSubmissionId: 's1', consent },
    { firstName: 'Kilo again', email: 'KILO@example.com', sourceSubmissionId: 's2', consent }] }, { cookie: sid });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual({ created: r.body.created, linked: r.body.linked, reconciled: r.body.reconciled }, { created: 1, linked: 1, reconciled: true });
  const p = (await db.sql`SELECT origin, intake, is_test FROM participants`)[0];
  assert.equal(p.origin, 'import:netlify_forms_export'); assert.equal(p.intake.exportedAt, '2026-11-24'); assert.equal(p.is_test, null);
  const ledger = await db.sql`SELECT provenance, source_submission_id, consent, receipt_id FROM pilot_intake_records ORDER BY source_submission_id`;
  assert.deepEqual(ledger.map(l => [l.provenance, l.source_submission_id, l.consent.value, l.consent.version, l.receipt_id]), [['founder_import', 's1', 'yes', 'pilot-form:2026-11', r.body.receiptId], ['founder_import', 's2', 'yes', 'pilot-form:2026-11', r.body.receiptId]]);
  const again = await w.call('POST', 'participants/import', { ...base, records: [{ firstName: 'Kilo', email: 'kilo@example.com', source: 'direct', submittedAt: '2026-11-12T10:00:00Z', sourceSubmissionId: 's1', consent }] }, { cookie: sid });
  assert.equal(again.body.alreadyImported, 1); assert.equal(again.body.reconciled, false, '1 of 2 rows does not reconcile');
});
test('R2-03: the pilot form consent version matches the text the form shows', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const label = html.match(/name="consent"[^>]*>\s*<span>([\s\S]*?)<\/span>/)[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(label, PILOT_CONSENT_TEXT, 'consent text changed: update PILOT_CONSENT_TEXT so new registrations carry a new version');
});

// ---------- Relationships (IR-05) ----------
test('IR-05: relationship edits are version-checked, owned, and cannot undo an offer approval', async () => {
  const w = world();
  const { sid, csid } = await team(w);
  const mine = (await w.call('POST', 'relationships', { contactName: 'Synthetic A', organization: 'Example College' }, { cookie: csid })).body.relationship;
  const theirs = (await w.call('POST', 'relationships', { contactName: 'Synthetic B', organization: 'Example College' }, { cookie: sid })).body.relationship;
  assert.equal((await w.call('PATCH', `relationships/${theirs.id}`, { notes: 'x', version: theirs.version }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `relationships/${mine.id}`, { offerApproved: true }, { cookie: csid })).status, 403);
  assert.equal((await w.call('PATCH', `relationships/${mine.id}`, { offerApproved: true }, { cookie: sid })).status, 200);
  assert.equal((await w.call('PATCH', `relationships/${mine.id}`, { notes: 'old screen', version: mine.version }, { cookie: csid })).status, 409);
  const cur = (await w.call('GET', 'relationships', undefined, { cookie: csid })).body.relationships.find(r => r.id === mine.id);
  assert.equal(cur.offerApproved, true);
  assert.equal((await w.call('PATCH', `relationships/${mine.id}`, { notes: 'fresh', version: cur.version }, { cookie: csid })).body.relationship.offerApproved, true);
  assert.equal((await w.call('POST', `relationships/${theirs.id}/log`, { kind: 'meeting', summary: 'Met' }, { cookie: csid })).status, 201, 'anyone can log contact');
});

// ---------- Company docs ----------
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(200, 32), Buffer.from('%%EOF')]);
const up = (title, extra = {}, bytes = PDF, fileName = 'one-pager.pdf') => ({ title, fileName, dataBase64: bytes.toString('base64'), category: 'outreach', ...extra });

test('docs: founder shares a file; coordinator lists and downloads it with safe headers', async () => {
  const w = world();
  const { sid, csid } = await team(w);
  const before = w.mail.length;
  const r = await w.call('POST', 'resources/upload', up('PRC one-pager', { audience: 'team', notify: true }), { cookie: sid });
  assert.equal(r.status, 201, JSON.stringify(r.body)); assert.equal(r.body.notified, 1); assert.equal(w.mail.length, before + 1);
  assert.equal(r.body.resource.fileKey, undefined);
  const doc = (await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources.find(x => x.title === 'PRC one-pager');
  const res = await w.call('GET', `resources/${doc.id}/file`, undefined, { cookie: csid });
  assert.equal(res.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await res.res.arrayBuffer()), PDF), 0);
  assert.match(res.headers.get('content-disposition'), /^attachment;/); assert.equal(res.headers.get('x-content-type-options'), 'nosniff'); assert.match(res.headers.get('content-security-policy'), /sandbox/);
});

test('docs: private and named-person documents stay hidden; bad files are refused', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  const priv = (await w.call('POST', 'resources/upload', up('Founder notes', { audience: 'founder' }), { cookie: sid })).body.resource;
  const named = (await w.call('POST', 'resources/upload', up('For coordinator', { audience: [coordId] }), { cookie: sid })).body.resource;
  const titles = (await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources.map(r => r.title);
  assert.ok(!titles.includes('Founder notes')); assert.ok(titles.includes('For coordinator'));
  assert.equal((await w.call('GET', `resources/${priv.id}/file`, undefined, { cookie: csid })).status, 404);
  assert.equal((await w.call('GET', `resources/${named.id}/file`, undefined, { cookie: csid })).status, 200);
  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(40, ' '));
  for (const [bytes, name] of [[html, 'trick.pdf'], [html, 'page.html'], [Buffer.from('MZ' + 'x'.repeat(40)), 'tool.exe'], [PDF, 'one-pager.png']])
    assert.equal((await w.call('POST', 'resources/upload', up('Bad', {}, bytes, name), { cookie: sid })).status, 400, name);
  assert.equal((await w.call('POST', 'resources/upload', up('Big', {}, Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(4 * 1024 * 1024 + 10)])), { cookie: sid })).status, 400);
});

// ---------- Approvals ----------
test('approvals: coordinator uploads and messages go to the founder; only the founder decides, once', async () => {
  const w = world();
  const { sid, csid } = await team(w);
  const doc = (await w.call('POST', 'resources/upload', up('Draft flyer', { audience: 'team', approval: 'approved' }), { cookie: csid })).body.resource;
  assert.equal(doc.approval, 'pending_review'); assert.equal(doc.audience, 'founder');
  assert.equal(w.mail.at(-1).to.address, FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'approvals', { itemType: 'message', channel: 'email', to: 'Parenting Resources', message: 'Hi, could we share a flyer?' }, { cookie: csid })).status, 201);
  const inbox = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals;
  assert.equal(inbox.filter(a => a.status === 'pending').length, 2);
  const docApproval = inbox.find(a => a.itemType === 'document');
  assert.equal((await w.call('POST', `approvals/${docApproval.id}/decide`, { decision: 'approved', digest: docApproval.digest }, { cookie: csid })).status, 403);
  assert.equal((await w.call('POST', `approvals/${docApproval.id}/decide`, { decision: 'changes_requested', digest: docApproval.digest }, { cookie: sid })).status, 400, 'note required');
  const [a1, a2] = await Promise.all([w.call('POST', `approvals/${docApproval.id}/decide`, { decision: 'approved', audience: 'team', digest: docApproval.digest }, { cookie: sid }), w.call('POST', `approvals/${docApproval.id}/decide`, { decision: 'approved', digest: docApproval.digest }, { cookie: sid })]);
  assert.deepEqual([a1.status, a2.status].sort(), [200, 400]);
  const after = (await w.call('GET', 'resources', undefined, { cookie: csid })).body.resources.find(r => r.id === doc.id);
  assert.equal(after.approval, 'approved'); assert.equal(after.audience, 'team');
  assert.match(w.mail.at(-1).subject, /^Approved:/);
  const mine = (await w.call('GET', 'approvals', undefined, { cookie: csid })).body;
  assert.equal(mine.scope, 'mine'); assert.equal(mine.approvals.length, 2);
});

// ---------- Content calendar ----------
test('content: draft → approval → posted; nothing unapproved can be marked posted', async () => {
  const w = world();
  const { sid, csid } = await team(w);
  let p = (await w.call('POST', 'content', { channel: 'instagram', plannedDate: '2026-12-01', caption: 'Spin the wheel tonight!' }, { cookie: csid })).body.post;
  assert.equal(p.status, 'draft'); assert.equal(p.refLink, 'https://spinfamilyapp.com/?ref=instagram');
  assert.equal((await w.call('POST', `content/${p.id}/published`, { publishedUrl: 'https://instagram.com/p/x' }, { cookie: csid })).status, 400);
  p = (await w.call('POST', `content/${p.id}/submit`, {}, { cookie: csid })).body.post;
  assert.equal(p.status, 'in_review');
  assert.equal((await w.call('PATCH', `content/${p.id}`, { caption: 'sneaky edit' }, { cookie: csid })).status, 400, 'locked while in review');
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'content_post');
  await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid });
  p = (await w.call('GET', 'content', undefined, { cookie: csid })).body.posts[0];
  assert.equal(p.status, 'approved');
  assert.equal((await w.call('PATCH', `content/${p.id}`, { caption: 'changed' }, { cookie: csid })).status, 400);
  assert.equal((await w.call('PATCH', `content/${p.id}`, { caption: 'changed', confirmReapproval: true }, { cookie: csid })).body.post.status, 'draft');
  await w.call('POST', `content/${p.id}/submit`, {}, { cookie: csid });
  const ap2 = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'content_post' && a.status === 'pending');
  await w.call('POST', `approvals/${ap2.id}/decide`, { decision: 'approved', digest: ap2.digest }, { cookie: sid });
  assert.equal((await w.call('POST', `content/${p.id}/published`, { publishedUrl: 'https://instagram.com/p/x' }, { cookie: csid })).body.post.status, 'published');
});

// ---------- Research & surveys ----------
async function approvedSurvey(w, sid, csid) {
  const draft = (await w.call('GET', 'research', undefined, { cookie: csid })).body.surveys[0];
  await w.call('POST', `research/surveys/${draft.id}/submit`, {}, { cookie: csid });
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey' && a.status === 'pending');
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 200);
  return draft;
}
test('research: questionnaire and notice must be approved before any link; consent on the page; one-time links; results scoped by role', async () => {
  const w = world();
  const { sid, csid, coordId } = await team(w);
  const overview = (await w.call('GET', 'research', undefined, { cookie: csid })).body;
  const draft = overview.surveys[0];
  assert.equal(draft.status, 'draft'); assert.equal(draft.questions.length, 15);
  assert.ok(!JSON.stringify(draft.questions).match(/child'?s name|birthday|school/i));
  assert.equal(overview.notice.approvedCurrent, false);
  const p = await reviewedParticipant(w, sid, { firstName: 'Lima', email: 'lima@example.com', assignedTo: coordId });
  const other = (await w.call('POST', 'participants', { firstName: 'Mike', cohort: 'pilot' }, { cookie: sid })).body.participant;
  const cohort = (await w.call('POST', 'research/cohorts', { name: "Marilyn's parent testers", partner: 'Marilyn', plannedSize: '5', deadline: '2026-12-19' }, { cookie: sid })).body.id;
  assert.equal((await w.call('POST', `research/cohorts/${cohort}/enroll`, { participantId: p.id, status: 'consented' }, { cookie: csid })).status, 400, 'nobody can set "consented"');
  assert.equal((await w.call('POST', `research/cohorts/${cohort}/enroll`, { participantId: p.id }, { cookie: csid })).status, 201);
  assert.equal((await w.call('POST', `research/cohorts/${cohort}/enroll`, { participantId: other.id }, { cookie: csid })).status, 400, 'only assigned');
  assert.equal((await w.call('POST', 'research/sessions', { cohortId: cohort, participantId: p.id, kind: 'initial', completed: true, observations: 'Found the wheel quickly' }, { cookie: csid })).status, 201);
  assert.equal((await w.call('POST', 'research/invites', { surveyId: draft.id, participantId: p.id }, { cookie: csid })).status, 400, 'notice not approved');
  assert.equal((await w.call('POST', 'research/notice/approve', { version: overview.notice.current.version }, { cookie: csid })).status, 403);
  assert.equal((await w.call('POST', 'research/notice/approve', { version: overview.notice.current.version }, { cookie: sid })).status, 200);
  assert.equal((await w.call('POST', 'research/invites', { surveyId: draft.id, participantId: p.id }, { cookie: csid })).status, 400, 'draft cannot be sent');
  await approvedSurvey(w, sid, csid);
  const inv = await w.call('POST', 'research/invites', { surveyId: draft.id, participantId: p.id, cohortId: cohort }, { cookie: csid });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = inv.body.link.match(/#t=([\w-]+)/)[1];
  assert.match(inv.body.link, /^https:\/\/spinfamilyapp\.com\/pilot\/survey\/#t=/);
  const load = await w.call('POST', 'public/survey/load', { token });
  assert.equal(load.status, 200); assert.equal(load.body.questions.length, 15); assert.ok(!JSON.stringify(load.body).includes('lima@example.com'));
  assert.equal(load.body.consentOnFile, false); assert.ok(load.body.notice.text.length >= 3);
  assert.equal((await w.call('POST', 'public/survey/submit', { token, answers: { q4: 5 } })).body.error.code, 'consent_required');
  const yes = { consent: true, noticeVersion: load.body.notice.version };
  assert.equal((await w.call('POST', 'public/survey/submit', { token, ...yes, answers: { q4: 9 } })).status, 400, 'scale checked');
  assert.equal((await w.call('POST', 'public/survey/submit', { token, ...yes, answers: { zzz: 'x' } })).status, 400, 'unknown question');
  const [s1, s2] = await Promise.all([
    w.call('POST', 'public/survey/submit', { token, ...yes, answers: { q4: 5, q7: 'yes', q13: 'Maybe', q15: 'Loved the wheel' } }),
    w.call('POST', 'public/survey/submit', { token, ...yes, answers: { q4: 1 } }),
  ]);
  assert.deepEqual([s1.status, s2.status].sort(), [200, 400], 'single use under parallel submits');
  assert.equal((await w.call('POST', 'public/survey/load', { token })).status, 400);
  assert.equal((await db.sql`SELECT count(*)::int n FROM research_consents WHERE method = 'participant_survey_page'`)[0].n, 1);
  const coordResults = (await w.call('GET', `research/surveys/${draft.id}/results`, undefined, { cookie: csid })).body;
  assert.equal(coordResults.responses, '<5', 'fewer than 5 responses are hidden from coordinators'); assert.equal(coordResults.individual, null);
  assert.deepEqual(coordResults.summary.find(q => q.id === 'q4').counts, {});
  const founderResults = (await w.call('GET', `research/surveys/${draft.id}/results`, undefined, { cookie: sid })).body;
  assert.equal(founderResults.individual.length, 1);
  // Whichever parallel submit won is the one saved, in full.
  const winner = s1.status === 200 ? 'Loved the wheel' : undefined;
  assert.deepEqual(founderResults.summary.find(q => q.id === 'q15').answers, winner ? [winner] : []);
  assert.equal(founderResults.individual[0].answers.q4, s1.status === 200 ? 5 : 1);
  assert.equal((await w.call('GET', `participants/${p.id}`, undefined, { cookie: sid })).body.participant.engagement, 'unknown', 'a survey answer does not change engagement');
});

// ---------- Preview / production boundary (IR-02) ----------
test('IR-02: production is recognised only from trusted runtime facts; anything else fails closed', () => {
  assert.equal(runtimeFacts({ site: { id: SITE_ID }, deploy: { context: 'production' } }, () => undefined).isProduction, true);
  assert.equal(runtimeFacts({ site: { id: SITE_ID }, deploy: { context: 'deploy-preview' } }, () => undefined).isProduction, false);
  assert.equal(runtimeFacts({}, () => undefined).isProduction, false, 'missing context');
  assert.equal(runtimeFacts({ site: { id: 'other-site' }, deploy: { context: 'production' } }, () => undefined).isProduction, false, 'wrong site');
  assert.equal(runtimeFacts(undefined, k => ({ SITE_ID, CONTEXT: 'production' })[k]).isProduction, true);
  assert.equal(runtimeFacts(undefined, k => ({ SITE_ID })[k]).isProduction, false, 'CONTEXT missing');
  assert.equal(runtimeFacts({ site: { id: SITE_ID }, deploy: { context: 'dev' } }, () => undefined).supported, false, 'unsupported context');
  assert.equal(runtimeFacts({ site: { id: SITE_ID } }, () => undefined).supported, false, 'unknown context');
  assert.equal(runtimeFacts({ site: { id: SITE_ID }, deploy: { context: 'branch-deploy' } }, () => undefined).supported, true);
  const prodSecrets = secretsFor({ isProduction: true }, k => ({ OPS_FOUNDER_BOOTSTRAP_CODE: 'a', OPS_FOUNDER_RECOVERY_CODE: 'b', OPS_PREVIEW_BOOTSTRAP_CODE: 'c' })[k]);
  const previewSecrets = secretsFor({ isProduction: false }, k => ({ OPS_FOUNDER_BOOTSTRAP_CODE: 'a', OPS_FOUNDER_RECOVERY_CODE: 'b', OPS_PREVIEW_BOOTSTRAP_CODE: 'c' })[k]);
  assert.deepEqual([prodSecrets.bootstrap, prodSecrets.recovery], ['a', 'b']);
  assert.deepEqual([previewSecrets.bootstrap, previewSecrets.recovery], ['c', null], 'previews never read production codes');
});
test('IR-02: intake function and API stay out of production and email outside production', () => {
  const intake = readFileSync(new URL('../netlify/functions/ops-intake.mjs', import.meta.url), 'utf8');
  assert.match(intake, /if \(!facts\.isProduction\)/); assert.doesNotMatch(intake, /!process\.env\.CONTEXT/);
  const api = readFileSync(new URL('../netlify/functions/ops-api.mjs', import.meta.url), 'utf8');
  assert.match(api, /if \(!facts\.isProduction\) throw new Error\('Email is turned off outside production'\)/);
  assert.match(api, /filesFor\(facts\.isProduction\)/); assert.match(api, /refused_unknown_site/); assert.match(api, /refused_unsupported_context/);
  // The database client is created only after the guards (R2-02).
  assert.ok(api.indexOf('getDatabase()') > api.indexOf('refused_unsupported_context'), 'no database client before the guard');
  assert.doesNotMatch(api.slice(0, api.indexOf('export default')), /getDatabase\(\)/);
  assert.match(intake, /checkEnvironment/);
  assert.match(readFileSync(new URL('../lib/ops/files.mjs', import.meta.url), 'utf8'), /getDeployStore/);
});
test('preview sign-in through Netlify team login is preview-only', async () => {
  const prod = world({ deployContext: 'production', netlifyUser: { id: 'u1', email: FOUNDER_EMAIL } });
  assert.equal((await prod.call('POST', 'auth/preview', {})).status, 404);
  const prev = world({ deployContext: 'deploy-preview', netlifyUser: { id: 'u1', email: FOUNDER_EMAIL } });
  assert.equal((await prev.call('POST', 'auth/preview', {})).status, 200);
  const stranger = world({ deployContext: 'deploy-preview', netlifyUser: { id: 'u2', email: 'someone@example.com' } });
  assert.equal((await stranger.call('POST', 'auth/preview', {})).status, 403);
});

// ---------- Records integrity ----------
const appendOnly = e => /append-only/.test(`${e.message} ${e.cause?.message || ''}`);
test('history, audit and intake ledger cannot be edited or deleted', async () => {
  const w = world();
  await team(w);
  await ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z');
  for (const t of ['audit_events', 'participant_history', 'pilot_intake_records'])
    await assert.rejects(async () => { await db.sql.unsafe(`DELETE FROM ${t}`); }, appendOnly, t);
  await assert.rejects(async () => { await db.sql`UPDATE audit_events SET action = 'x'`; }, appendOnly);
  await assert.rejects(async () => { await db.sql`UPDATE participant_history SET changes = '[]'::jsonb`; }, appendOnly, 'no redaction outside the workflow');
});
test('audit log holds ids and actions, not email addresses', async () => {
  const w = world();
  await team(w);
  assert.ok(!JSON.stringify(await db.sql`SELECT actor, action, target, extra FROM audit_events`).includes('@'));
});
test('IR-06: errors are logged without personal details and do not claim nothing changed', async () => {
  const w = world();
  const logs = []; w.deps.log = e => logs.push(e);
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const real = db.sql;
  w.deps.sql = new Proxy(real, { apply(t, thisArg, args) { if (String(args[0]?.[0] || '').startsWith('SELECT * FROM participants WHERE org_id')) throw Object.assign(new Error('boom secret@example.com'), { code: 'XX000' }); return Reflect.apply(t, thisArg, args); } });
  const r = await w.call('GET', 'participants', undefined, { cookie: sid });
  assert.equal(r.status, 500); assert.match(r.body.error.message, /check whether your change was saved/);
  assert.ok(logs.length && !JSON.stringify(logs).includes('@'));
});

// ---------- Source safety ----------
test('front end has no third-party code, inline scripts or browser storage', () => {
  for (const f of ['../public/operations/ops.js', '../public/pilot/survey/survey.js']) {
    const js = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(js, /localStorage|sessionStorage|innerHTML|eval\(|https?:\/\/(?!spinfamilyapp)/, f);
  }
  for (const f of ['../public/operations/index.html', '../public/pilot/survey/index.html']) {
    const html = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script>(?!<\/script>)|https?:\/\//, f); assert.match(html, /noindex/);
  }
});
test('existing welcome email and the scheduled batch are untouched', () => {
  const toml = readFileSync(new URL('../../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /for = "\/operations\/\*"/);
  // The batch function is owned by landing (now its bounded recovery version); the workspace never imports or changes it.
  const batch = readFileSync(new URL('../netlify/functions/welcome-batch-20261125.mjs', import.meta.url), 'utf8');
  assert.match(batch, /recoverWelcome/);
  for (const f of ['core', 'records', 'outbox', 'docs', 'approvals', 'content', 'research'])
    assert.doesNotMatch(readFileSync(new URL(`../lib/ops/${f}.mjs`, import.meta.url), 'utf8'), /welcome-batch|welcome-recovery|pilot-welcome-v1/, f);
});

test('preview founder login mapping: works only on previews, only for the configured Netlify login', async () => {
  const w = world({ deployContext: 'deploy-preview', netlifyUser: { email: 'Founder.Personal@example.com' } });
  assert.equal((await w.call('POST', 'auth/preview', {})).status, 403, 'not mapped without the setting');
  w.deps.previewFounderLogin = 'founder.personal@example.com';
  const r = await w.call('POST', 'auth/preview', {});
  assert.equal(r.status, 200);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: r.sid })).body.member.email, FOUNDER_EMAIL);
  w.deps.netlifyUser = { email: 'someone.else@example.com' };
  assert.equal((await w.call('POST', 'auth/preview', {})).status, 403);
  const prod = world({ deployContext: 'production', netlifyUser: { email: 'founder.personal@example.com' } });
  prod.deps.previewFounderLogin = 'founder.personal@example.com';
  assert.equal((await prod.call('POST', 'auth/preview', {})).status, 404, 'never on production');
});
