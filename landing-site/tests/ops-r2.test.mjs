// PR #28 review R2 (6051609689): multi-connection and fault tests for R2-01..R2-05.
// Real PostgreSQL 17, a pool of separate connections, and named pause points (barriers) so each
// interleaving runs the same way every time. `waitForLockWait` proves the second request is
// actually queued behind the first one's lock, not merely slower.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FOUNDER_EMAIL } from '../lib/ops/core.mjs';
import { ingestPilotSubmission } from '../lib/ops/records.mjs';
import { checkEnvironment } from '../lib/ops/environment.mjs';
import { SITE_ID } from '../lib/pilot-welcome.mjs';
import { startDatabase, world as makeWorld, team, barriers, waitForLockWait, COORD, FORM, reviewedParticipant, researchReady, surveyLink } from './helpers/harness.mjs';

let pgdb, db;
before(async () => { pgdb = await startDatabase(); db = pgdb.db; });
after(async () => { await pgdb?.stop(); });
beforeEach(async () => { await pgdb.reset(); });
const setup = (opts = {}) => { const b = barriers(); return { b, w: makeWorld(db, { ...opts, hook: b.hook }) }; };
const failAt = name => async n => { if (n === name) throw Object.assign(new Error('injected fault'), { code: 'TEST_FAULT' }); };
const count = async (table, where = 'true') => (await db.sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))[0].n;

// =============================== R2-01 ===============================
test('R2-01: a link request paused under lock cannot outlive an email change that queues behind it', async () => {
  const { b, w } = setup();
  const { sid, coordId } = await team(w);
  w.tick(16 * 60000);
  const gate = b.arm('link.issue.locked');
  const before = w.mail.length;
  const issuing = w.call('POST', 'auth/request', { email: COORD });
  await gate.reached;
  const change = w.call('PATCH', `team/${coordId}`, { email: 'moved@example.com' }, { cookie: sid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  await issuing; assert.equal((await change).status, 200);
  assert.equal(w.mail.length, before + 1, 'the link was issued before the change');
  const token = w.mail.at(-1).text.match(/#signin=([\w-]+)/)[1];
  assert.equal((await w.call('POST', 'auth/verify', { token })).status, 400, 'but it died with the old generation');
});

test('R2-01: a link request that queues behind an email change finds nobody at the old address', async () => {
  const { b, w } = setup();
  const { sid, coordId } = await team(w);
  w.tick(16 * 60000);
  const gate = b.arm('team.change.locked');
  const change = w.call('PATCH', `team/${coordId}`, { email: 'moved@example.com' }, { cookie: sid });
  await gate.reached;
  const before = w.mail.length;
  const issuing = w.call('POST', 'auth/request', { email: COORD });
  await waitForLockWait(pgdb.pool);
  gate.release();
  await change; await issuing;
  assert.equal(w.mail.length, before, 'no link to the old address');
});

for (const action of ['revoke', 'sign_out_everywhere', 'reset_authenticator']) {
  test(`R2-01: a link issued while "${action}" waits for the lock is dead afterwards`, async () => {
    const { b, w } = setup();
    const { sid, coordId } = await team(w);
    w.tick(16 * 60000);
    const gate = b.arm('link.issue.locked');
    const issuing = w.call('POST', 'auth/request', { email: COORD });
    await gate.reached;
    const change = w.call('PATCH', `team/${coordId}`, { action }, { cookie: sid });
    await waitForLockWait(pgdb.pool);
    gate.release();
    await issuing; assert.equal((await change).status, 200);
    const token = w.mail.at(-1).text.match(/#signin=([\w-]+)/)[1];
    assert.equal((await w.call('POST', 'auth/verify', { token })).status, 400);
  });
}

test('R2-01: claim vs revoke, both orders: no session survives the revocation', async () => {
  // Claim first, revoke queued behind it: the new session is killed by the revoke.
  let { b, w } = setup();
  let { sid, coordId } = await team(w);
  w.tick(16 * 60000);
  let token = await w.requestLink(COORD);
  let gate = b.arm('link.claim.locked');
  const claiming = w.call('POST', 'auth/verify', { token });
  await gate.reached;
  let revoking = w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  const claimed = await claiming; await revoking;
  assert.equal(claimed.status, 200);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: claimed.sid })).status, 401);
  assert.equal(await count('sessions', `member_id = '${coordId}'`), 0);

  // Revoke first, claim queued behind it: the link is refused.
  await pgdb.reset();
  ({ b, w } = setup());
  ({ sid, coordId } = await team(w));
  w.tick(16 * 60000);
  token = await w.requestLink(COORD);
  gate = b.arm('team.change.locked');
  revoking = w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid });
  await gate.reached;
  const claim2 = w.call('POST', 'auth/verify', { token });
  await waitForLockWait(pgdb.pool);
  gate.release();
  await revoking;
  assert.equal((await claim2).status, 400);
});

test('R2-01: restore never revives a link or session from before the revoke', async () => {
  const { w } = setup();
  const { sid, csid, coordId } = await team(w);
  w.tick(16 * 60000);
  const token = await w.requestLink(COORD);
  await w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid });
  await w.call('PATCH', `team/${coordId}`, { action: 'restore' }, { cookie: sid });
  assert.equal((await w.call('POST', 'auth/verify', { token })).status, 400);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: csid })).status, 401);
  const gens = (await db.sql`SELECT auth_generation FROM members WHERE id = ${coordId}`)[0].auth_generation;
  assert.ok(Number(gens) >= 4, 'invite enrollment, revoke and restore each moved the generation');
});

test('R2-01: one TOTP code, two sessions, second one queued on the member lock: exactly one succeeds', async () => {
  const { b, w } = setup();
  const { secret } = await w.ready(FOUNDER_EMAIL);
  w.tick(60000);
  const s1 = await w.signIn(FOUNDER_EMAIL), s2 = await w.signIn(FOUNDER_EMAIL);
  const code = w.code(secret);
  const gate = b.arm('mfa.verify.locked');
  const first = w.call('POST', 'auth/mfa', { code }, { cookie: s1 });
  await gate.reached;
  const second = w.call('POST', 'auth/mfa', { code }, { cookie: s2 });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.deepEqual([(await first).status, (await second).status], [200, 400]);
});

test('R2-01: authenticator confirmation consumes the exact pending setup once; a replaced setup cannot be confirmed', async () => {
  const { w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  await w.call('POST', 'team/invite', { email: COORD, name: 'C', role: 'coordinator' }, { cookie: sid });
  const csid = await w.signIn(COORD);
  const first = await w.setup(csid, false);
  const second = await w.setup(csid, false);
  assert.equal((await w.call('POST', 'auth/authenticator/confirm', { setupId: first.setupId, code: w.code(first.secret) }, { cookie: csid })).status, 400, 'replaced setup');
  const both = await Promise.all([1, 2].map(() => w.call('POST', 'auth/authenticator/confirm', { setupId: second.setupId, code: w.code(second.secret) }, { cookie: csid })));
  assert.deepEqual(both.map(r => r.status).sort(), [200, 400]);
  assert.equal((await db.sql`SELECT totp_secret FROM members WHERE email = ${COORD}`)[0].totp_secret, second.secret);
});

test('R2-01: an authenticator reset that queues behind a confirmation wins: the factor and session are gone', async () => {
  const { b, w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const inv = await w.call('POST', 'team/invite', { email: COORD, name: 'C', role: 'coordinator' }, { cookie: sid });
  const csid = await w.signIn(COORD);
  const s = await w.setup(csid, false);
  const gate = b.arm('factor.confirm.locked');
  const confirming = w.call('POST', 'auth/authenticator/confirm', { setupId: s.setupId, code: w.code(s.secret) }, { cookie: csid });
  await gate.reached;
  const reset = w.call('PATCH', `team/${inv.body.member.id}`, { action: 'reset_authenticator' }, { cookie: sid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.equal((await confirming).status, 200); assert.equal((await reset).status, 200);
  const m = (await db.sql`SELECT totp_enabled FROM members WHERE email = ${COORD}`)[0];
  assert.equal(m.totp_enabled, false);
  assert.equal((await w.call('GET', 'auth/me', undefined, { cookie: csid })).status, 401);
});

test('R2-01: wrong codes are limited per person across sessions, not just per session', async () => {
  const { w } = setup();
  const { secret } = await w.ready(FOUNDER_EMAIL);
  w.tick(16 * 60000);
  const sessions = [await w.signIn(FOUNDER_EMAIL), await w.signIn(FOUNDER_EMAIL), await w.signIn(FOUNDER_EMAIL)];
  // Four wrong codes in each session: no single session reaches its limit of five...
  const statuses = [];
  for (const s of sessions) for (let j = 0; j < 4; j++) statuses.push((await w.call('POST', 'auth/mfa', { code: '000000' }, { cookie: s })).status);
  // ...but after ten for the person, every further attempt is refused, even with the right code.
  assert.deepEqual(statuses, [...Array(10).fill(400), 429, 429]);
  const r = await w.call('POST', 'auth/mfa', { code: w.code(secret) }, { cookie: sessions[0] });
  assert.equal(r.status, 429, JSON.stringify(r.body));
  w.tick(16 * 60000);
  const later = await w.signIn(FOUNDER_EMAIL);
  assert.equal((await w.call('POST', 'auth/mfa', { code: w.code(secret) }, { cookie: later })).status, 200, 'works again after the window');
});

test('R2-01: the bootstrap code works once per organization', async () => {
  const { w } = setup();
  await w.ready(FOUNDER_EMAIL);
  assert.equal(await count('secret_uses', "purpose = 'founder_bootstrap'"), 1);
  // Even if the authenticator were somehow cleared, the setup code cannot enroll a new one.
  await db.sql`UPDATE members SET totp_enabled = false, totp_secret = NULL WHERE email = ${FOUNDER_EMAIL}`;
  w.tick(16 * 60000);
  const sid = await w.signIn(FOUNDER_EMAIL);
  const r = await w.call('POST', 'auth/authenticator/setup', { enrollmentCode: 'test-bootstrap-code' }, { cookie: sid });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'bootstrap_used');
});

// =============================== R2-02 ===============================
test('R2-02: database environment marker: previews never serve a production database, production never a synthetic one', async () => {
  const prod = { siteId: SITE_ID, deployContext: 'production', supported: true, isProduction: true };
  const preview = { siteId: SITE_ID, deployContext: 'deploy-preview', supported: true, isProduction: false };
  assert.deepEqual(await checkEnvironment(db.sql, { ...preview, supported: false }), { ok: false, reason: 'unsupported_context' });
  assert.equal((await checkEnvironment(db.sql, prod)).ok, true, 'production marks a fresh database');
  assert.equal((await db.sql`SELECT kind FROM ops_environment`)[0].kind, 'production');
  assert.deepEqual(await checkEnvironment(db.sql, preview), { ok: false, reason: 'preview_on_production_data' }, 'a fork of production is refused');
  await pgdb.reset();
  assert.equal((await checkEnvironment(db.sql, preview)).ok, true, 'an empty database becomes synthetic');
  assert.deepEqual(await checkEnvironment(db.sql, prod), { ok: false, reason: 'production_on_synthetic_database' });
  await pgdb.reset();
  await db.sql`INSERT INTO members (id, email, name) VALUES ('m_x', 'x@example.com', 'X')`;
  const r = await checkEnvironment(db.sql, preview);
  assert.equal(r.ok, false); assert.equal(r.reason, 'unmarked_database_has_data', 'an unmarked database with records is refused');
  await pgdb.reset();
  await db.sql`INSERT INTO ops_environment (singleton, kind, site_id, context, marked_at) VALUES (true, 'synthetic', 'another-site', 'deploy-preview', now())`;
  assert.deepEqual(await checkEnvironment(db.sql, preview), { ok: false, reason: 'database_from_another_site' });
});

// =============================== R2-03 ===============================
test('R2-03: intake is one transaction: a failure between statements leaves nothing, and a retry records it once', async () => {
  for (const point of ['intake.after_participant', 'intake.before_history']) {
    await pgdb.reset();
    const w = makeWorld(db, { hook: failAt(point) });
    await assert.rejects(ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z', { submissionId: 'sub-f' }));
    for (const t of ['participants', 'pilot_intake_records', 'participant_history', 'cohort_memberships']) assert.equal(await count(t), 0, `${point}: ${t}`);
    const ok = makeWorld(db);
    assert.equal(await ingestPilotSubmission(ok.deps, FORM, '2026-11-24T16:00:00.000Z', { submissionId: 'sub-f' }), 'created');
    assert.equal(await count('pilot_intake_records'), 1);
  }
});

test('R2-03: parallel deliveries of the same submission queue on the intake lock: one record', async () => {
  const { b, w } = setup();
  const gate = b.arm('intake.after_participant');
  const a = ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z', { submissionId: 'sub-p' });
  await gate.reached;
  const c = ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:01.000Z', { submissionId: 'sub-p' });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.deepEqual([await a, await c], ['created', 'duplicate_event']);
  assert.equal(await count('participants'), 1);
});

test('R2-03: same submission id with different content is held for review, changes nobody, and blocks backfill completion', async () => {
  const { w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  assert.equal(await ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z', { submissionId: 'sub-c' }), 'created');
  assert.equal(await ingestPilotSubmission(w.deps, { ...FORM, first_name: 'Someone', email: 'other@example.com' }, '2026-11-24T16:01:00.000Z', { submissionId: 'sub-c' }), 'conflict');
  assert.equal(await count('participants'), 1); assert.equal(await count('intake_conflicts', "status = 'open'"), 1);
  const imp = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'f.csv', exportedAt: '2026-11-24', expectedCount: 0, records: [] }, { cookie: sid });
  const app = await w.call('POST', 'participants/import', { source: 'app_identity_export', exportRef: 'a.csv', exportedAt: '2026-11-24', expectedCount: 0, records: [] }, { cookie: sid });
  const ids = [imp.body.receiptId, app.body.receiptId];
  const blocked = await w.call('POST', 'participants/backfill', { receiptIds: ids }, { cookie: sid });
  assert.equal(blocked.status, 400); assert.match(blocked.body.error.message, /conflict/);
  const c = (await w.call('GET', 'participants/intake-conflicts', undefined, { cookie: sid })).body.conflicts[0];
  assert.equal((await w.call('POST', `participants/intake-conflicts/${c.id}/resolve`, { resolution: 'Second delivery was a Netlify retry with edited fields; kept the first' }, { cookie: sid })).status, 200);
  assert.equal((await w.call('POST', 'participants/backfill', { receiptIds: ids }, { cookie: sid })).status, 200);
});

test('R2-03: an import that does not reconcile with its export cannot complete the backfill', async () => {
  const { w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const one = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'f.csv', exportedAt: '2026-11-24', expectedCount: 3, consentEvidence: 'Archived form page, Drive', records: [{ firstName: 'Papa', email: 'papa@example.com', sourceSubmissionId: 's-p', consent: { value: 'yes', version: 'v1' } }] }, { cookie: sid });
  assert.equal(one.body.reconciled, false);
  const app = await w.call('POST', 'participants/import', { source: 'app_identity_export', exportRef: 'a.csv', exportedAt: '2026-11-24', expectedCount: 0, records: [] }, { cookie: sid });
  const r = await w.call('POST', 'participants/backfill', { receiptIds: [one.body.receiptId, app.body.receiptId] }, { cookie: sid });
  assert.equal(r.status, 400); assert.match(r.body.error.message, /netlify_forms_export/);
  assert.equal((await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.coverage, 'incomplete');
});

test('R2-03: metrics come from evidence: prospect conversion counts; tests, unreviewed and withdrawn do not; households counted apart; pilot_completed is not activation', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  // A prospect added by hand who then registers through the form is a registration.
  const prospect = (await w.call('POST', 'participants', { firstName: 'Quebec', email: 'quebec@example.com' }, { cookie: csid })).body.participant;
  assert.equal(await ingestPilotSubmission(w.deps, { ...FORM, first_name: 'Quebec', email: 'quebec@example.com' }, '2026-11-24T16:00:00.000Z'), 'promoted_prospect');
  let q = (await w.call('GET', `participants/${prospect.id}`, undefined, { cookie: sid })).body.participant;
  q = (await w.call('PATCH', `participants/${q.id}`, { isTest: false, householdKey: 'H1', version: q.version }, { cookie: sid })).body.participant;
  const r2 = await reviewedParticipant(w, sid, { firstName: 'Romeo', email: 'romeo@example.com' });
  await w.call('PATCH', `participants/${r2.id}`, { householdKey: 'H1', version: r2.version }, { cookie: sid });
  await reviewedParticipant(w, sid, { firstName: 'Sierra', email: 'sierra@example.com' });
  await ingestPilotSubmission(w.deps, { ...FORM, first_name: 'Tango', email: 'tango@example.com' }, '2026-11-24T16:05:00.000Z'); // unreviewed
  const test1 = await reviewedParticipant(w, sid, { firstName: 'Uniform', email: 'uniform@example.com' });
  await w.call('PATCH', `participants/${test1.id}`, { isTest: true, version: test1.version }, { cookie: sid });
  const leaver = await reviewedParticipant(w, sid, { firstName: 'Victor', email: 'victor@example.com' });
  assert.equal((await w.call('POST', `participants/${leaver.id}/withdraw`, { note: 'Replied asking to stop' }, { cookie: sid })).status, 200);
  // Founder marks Sierra's engagement as pilot_completed (verified): that is not activation.
  let s = (await w.call('GET', 'participants', undefined, { cookie: sid })).body.participants.find(p => p.firstName === 'Sierra');
  s = (await w.call('PATCH', `participants/${s.id}`, { engagement: 'pilot_completed', verify: { engagement: true }, evidenceNote: 'Checked app logs', version: s.version }, { cookie: sid })).body.participant;
  const m = Object.fromEntries((await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.metrics.map(x => [x.id, x]));
  assert.equal(m.registrations.value, 3, 'Quebec, Romeo, Sierra');
  assert.deepEqual(m.registrations.households, { known: 1, notRecorded: 1 }, 'Quebec and Romeo share household H1; Sierra has none recorded');
  assert.match(m.registrations.definition, /1 waiting for review/); assert.match(m.registrations.definition, /1 withdrew/);
  assert.equal(m.activation.value, 0, 'pilot_completed is not activation');
  // A withdrawn record can't be edited back into the numbers.
  const v = (await w.call('GET', `participants/${leaver.id}`, undefined, { cookie: sid })).body.participant;
  assert.equal((await w.call('PATCH', `participants/${leaver.id}`, { notes: 'x', version: v.version }, { cookie: sid })).status, 400);
});

test('R2-03: governed redaction scrubs history, intake and survey answers inside the workflow only, and records that it happened', async () => {
  const { w } = setup();
  const { sid, csid, coordId } = await team(w);
  const p = await reviewedParticipant(w, sid, { firstName: 'Whiskey', email: 'whiskey@example.com', assignedTo: coordId });
  assert.equal((await w.call('POST', `participants/${p.id}/redact`, { reason: 'participant_request', confirm: 'REDACT' }, { cookie: csid })).status, 403);
  assert.equal((await w.call('POST', `participants/${p.id}/redact`, { reason: 'participant_request' }, { cookie: sid })).status, 400, 'must confirm');
  const r = await w.call('POST', `participants/${p.id}/redact`, { reason: 'participant_request', requestRef: 'email 2026-11-24', confirm: 'REDACT' }, { cookie: sid });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = (await db.sql`SELECT first_name, email, withdrawn_at FROM participants WHERE id = ${p.id}`)[0];
  assert.equal(row.first_name, '[redacted]'); assert.equal(row.email, ''); assert.ok(row.withdrawn_at);
  const hist = await db.sql`SELECT changes FROM participant_history WHERE participant_id = ${p.id}`;
  assert.ok(hist.length && hist.every(h => JSON.stringify(h.changes) === '[{"field":"redacted"}]'));
  assert.equal(await count('redaction_events'), 1);
  assert.ok(!JSON.stringify(await db.sql`SELECT * FROM redaction_events`).includes('whiskey'));
  await assert.rejects(async () => { await db.sql`UPDATE participant_history SET changes = '[]'::jsonb`; }, /append-only/, 'still append-only outside the workflow');
});

// =============================== R2-04 ===============================
test('R2-04: an edit after submission supersedes the request; the old request cannot be approved', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const s = (await w.call('GET', 'research', undefined, { cookie: csid })).body.surveys[0];
  await w.call('POST', `research/surveys/${s.id}/submit`, {}, { cookie: csid });
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey');
  assert.equal(ap.snapshot.questions.length, 15); assert.match(ap.digest, /^[a-f0-9]{64}$/);
  const edited = await w.call('PATCH', `research/surveys/${s.id}`, { intro: 'Changed after review was requested' }, { cookie: csid });
  assert.equal(edited.status, 200);
  const d = await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid });
  assert.equal(d.status, 400);
  assert.equal((await db.sql`SELECT status FROM approvals WHERE id = ${ap.id}`)[0].status, 'superseded');
  assert.equal((await db.sql`SELECT status FROM survey_definitions WHERE id = ${s.id}`)[0].status, 'draft', 'nothing approved');
});

test('R2-04: an edit queued behind an approval decision cannot change what was approved', async () => {
  const { b, w } = setup();
  const { sid, csid } = await team(w);
  const s = (await w.call('GET', 'research', undefined, { cookie: csid })).body.surveys[0];
  await w.call('POST', `research/surveys/${s.id}/submit`, {}, { cookie: csid });
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey');
  const gate = b.arm('approval.decide.checked');
  const deciding = w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid });
  await gate.reached;
  const editing = w.call('PATCH', `research/surveys/${s.id}`, { intro: 'Sneaky' }, { cookie: csid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.equal((await deciding).status, 200);
  assert.notEqual((await editing).body.survey?.intro, 'Sneaky');
  const final = (await db.sql`SELECT status, intro, revision FROM survey_definitions WHERE id = ${s.id}`)[0];
  assert.equal(final.status, 'approved'); assert.equal(final.intro, ap.snapshot.intro); assert.equal(final.revision, ap.itemVersion);
});

test('R2-04: approve and withdraw at once: one wins, the other is refused', async () => {
  const { b, w } = setup();
  const { sid, csid } = await team(w);
  let p = (await w.call('POST', 'content', { channel: 'instagram', caption: 'Spin tonight!' }, { cookie: csid })).body.post;
  p = (await w.call('POST', `content/${p.id}/submit`, { version: p.version }, { cookie: csid })).body.post;
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'content_post');
  assert.equal(ap.snapshot.caption, 'Spin tonight!', 'the full caption is what gets reviewed');
  const gate = b.arm('approval.decide.checked');
  const deciding = w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid });
  await gate.reached;
  const withdrawing = w.call('POST', `approvals/${ap.id}/withdraw`, {}, { cookie: csid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.deepEqual([(await deciding).status, (await withdrawing).status], [200, 400]);
  assert.equal((await db.sql`SELECT status FROM content_posts WHERE id = ${p.id}`)[0].status, 'approved');
});

test('R2-04: a failure between decision writes leaves the request pending and the old approved version in place', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const s = (await w.call('GET', 'research', undefined, { cookie: csid })).body.surveys[0];
  await w.call('POST', `research/surveys/${s.id}/submit`, {}, { cookie: csid });
  let ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey');
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 200);
  // v2: a new draft version, submitted for approval.
  const v2 = (await w.call('PATCH', `research/surveys/${s.id}`, { intro: 'Version two' }, { cookie: csid })).body.survey;
  assert.equal(v2.version, 2);
  await w.call('POST', `research/surveys/${v2.id}/submit`, {}, { cookie: csid });
  ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals.find(a => a.itemType === 'survey' && a.status === 'pending');
  const outboxBefore = await count('notifications_outbox');
  w.deps.hook = failAt('approval.survey.retired');
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 500);
  w.deps.hook = undefined;
  assert.equal((await db.sql`SELECT status FROM approvals WHERE id = ${ap.id}`)[0].status, 'pending');
  assert.deepEqual((await db.sql`SELECT version, status FROM survey_definitions ORDER BY version`).map(r => [r.version, r.status]), [[1, 'approved'], [2, 'draft']]);
  assert.equal(await count('notifications_outbox'), outboxBefore, 'no notification for a decision that did not happen');
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 200);
  assert.deepEqual((await db.sql`SELECT version, status FROM survey_definitions ORDER BY version`).map(r => [r.version, r.status]), [[1, 'retired'], [2, 'approved']]);
  await assert.rejects(async () => { await db.sql`UPDATE survey_definitions SET status = 'approved' WHERE version = 1`; }, /survey_one_approved|duplicate key/, 'only one approved version can exist');
});

test('R2-04: one pending request per item, and notifications go through the outbox after commit', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const p = (await w.call('POST', 'content', { channel: 'tiktok', caption: 'Wheel time' }, { cookie: csid })).body.post;
  w.deps.sendMail = async () => { throw Object.assign(new Error('smtp down'), { code: 'ECONNREFUSED' }); };
  assert.equal((await w.call('POST', `content/${p.id}/submit`, { version: p.version }, { cookie: csid })).status, 200, 'mail outage does not fail the submission');
  const queued = (await db.sql`SELECT sent_at, attempts, last_error FROM notifications_outbox`)[0];
  assert.equal(queued.sent_at, null); assert.equal(queued.attempts, 1); assert.equal(queued.last_error, 'ECONNREFUSED');
  const sent = [];
  w.deps.sendMail = async m => { sent.push(m); return { accepted: [m.to.address] }; };
  await w.call('POST', 'auth/logout', {});
  assert.equal(sent.length, 1, 'sent on the next request'); assert.equal(sent[0].to.address, FOUNDER_EMAIL);
  await assert.rejects(async () => { await db.sql`INSERT INTO approvals (id, org_id, item_type, item_id, title, submitted_by, submitted_at, status) SELECT 'ap_dup', org_id, item_type, item_id, 'dup', submitted_by, now(), 'pending' FROM approvals LIMIT 1`; }, /approvals_one_pending|duplicate key/);
});

// =============================== R2-05 ===============================
test('R2-05: survey links need an eligible, reviewed, consenting, in-scope person; one active link per questionnaire', async () => {
  const { w } = setup();
  const { sid, csid, coordId } = await team(w);
  const { survey } = await researchReady(w, sid, csid);
  const unreviewed = (await w.call('POST', 'participants', { firstName: 'Xray', email: 'xray@example.com' }, { cookie: csid })).body.participant;
  await db.sql`UPDATE participants SET is_test = NULL WHERE id = ${unreviewed.id}`;
  assert.equal((await w.call('POST', 'research/invites', { surveyId: survey.id, participantId: unreviewed.id }, { cookie: csid })).status, 400, 'unreviewed');
  const p = await reviewedParticipant(w, sid, { firstName: 'Yankee', email: 'yankee@example.com', assignedTo: coordId });
  const first = await surveyLink(w, csid, survey.id, p.id);
  const second = await surveyLink(w, csid, survey.id, p.id);
  assert.equal((await w.call('POST', 'public/survey/load', { token: first })).status, 400, 'a new link replaces the old one');
  assert.equal((await w.call('POST', 'public/survey/load', { token: second })).status, 200);
  await assert.rejects(async () => { await db.sql`INSERT INTO survey_invites (token_hash, org_id, survey_id, participant_id, created_by, created_at, expires_at) VALUES ('dup', 'spinfamily', ${survey.id}, ${p.id}, 'x', now(), 9e15)`; }, /survey_invite_one_active|duplicate key/);
  // Reassigned away from the coordinator: they can no longer send links to this person.
  const cur = (await w.call('GET', `participants/${p.id}`, undefined, { cookie: sid })).body.participant;
  await w.call('PATCH', `participants/${p.id}`, { assignedTo: null, version: cur.version }, { cookie: sid });
  assert.equal((await w.call('POST', 'research/invites', { surveyId: survey.id, participantId: p.id }, { cookie: csid })).status, 400);
  // Opted out of email: no link.
  const z = await reviewedParticipant(w, sid, { firstName: 'Zulu', email: 'zulu@example.com' });
  await w.call('PATCH', `participants/${z.id}`, { communication: 'opted_out', version: z.version }, { cookie: sid });
  assert.equal((await w.call('POST', 'research/invites', { surveyId: survey.id, participantId: z.id }, { cookie: sid })).status, 400);
  // Research switched off by flag: no links at all.
  w.deps.features = new Set();
  assert.equal((await w.call('POST', 'research/invites', { surveyId: survey.id, participantId: z.id }, { cookie: sid })).status, 400);
});

test('R2-05: a fault between claiming the link and saving the answers loses nothing', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const { survey, notice } = await researchReady(w, sid, csid);
  const p = await reviewedParticipant(w, sid, { firstName: 'Alfa', email: 'alfa@example.com' });
  const token = await surveyLink(w, sid, survey.id, p.id);
  const body = { token, consent: true, noticeVersion: notice.version, answers: { q4: 4 } };
  w.deps.hook = failAt('survey.submit.before_insert');
  assert.equal((await w.call('POST', 'public/survey/submit', body)).status, 500);
  w.deps.hook = undefined;
  assert.equal(await count('survey_responses'), 0); assert.equal(await count('research_consents'), 0);
  assert.equal((await w.call('POST', 'public/survey/load', { token })).status, 200, 'link still usable');
  assert.equal((await w.call('POST', 'public/survey/submit', body)).status, 200);
  assert.equal(await count('survey_responses'), 1);
});

test('R2-05: withdrawal vs submit, both orders', async () => {
  // Submit first, withdrawal queued behind it: the answer is saved, then excluded from results.
  let { b, w } = setup();
  let { sid, csid } = await team(w);
  let { survey, notice } = await researchReady(w, sid, csid);
  let p = await reviewedParticipant(w, sid, { firstName: 'Bravo', email: 'bravo@example.com' });
  let token = await surveyLink(w, sid, survey.id, p.id);
  const gate = b.arm('survey.submit.locked');
  const submitting = w.call('POST', 'public/survey/submit', { token, consent: true, noticeVersion: notice.version, answers: { q4: 5 } });
  await gate.reached;
  const withdrawing = w.call('POST', 'public/survey/withdraw', { token });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.equal((await submitting).status, 200); assert.equal((await withdrawing).status, 200);
  const results = (await w.call('GET', `research/surveys/${survey.id}/results`, undefined, { cookie: sid })).body;
  assert.equal(results.individual.length, 0, 'withdrawn answers are not reported');
  assert.equal(await count('research_consents', 'withdrawn_at IS NOT NULL'), 1);

  // Withdrawal first: the link no longer works.
  await pgdb.reset();
  ({ b, w } = setup());
  ({ sid, csid } = await team(w));
  ({ survey, notice } = await researchReady(w, sid, csid));
  p = await reviewedParticipant(w, sid, { firstName: 'Charlie', email: 'charlie@example.com' });
  token = await surveyLink(w, sid, survey.id, p.id);
  assert.equal((await w.call('POST', 'public/survey/withdraw', { token })).status, 200);
  assert.equal((await w.call('POST', 'public/survey/submit', { token, consent: true, noticeVersion: notice.version, answers: { q4: 5 } })).status, 400);
  assert.equal((await w.call('POST', 'research/invites', { surveyId: survey.id, participantId: p.id }, { cookie: sid })).status, 400, 'no new link after withdrawal');
});

test('R2-05: coordinators never see a group smaller than 5', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const { survey, notice } = await researchReady(w, sid, csid);
  const answers = ['Yes', 'Yes', 'Yes', 'Yes', 'Yes', 'Maybe'];
  for (const [i, a] of answers.entries()) {
    const p = await reviewedParticipant(w, sid, { firstName: `P${i}`, email: `p${i}@example.com` });
    const token = await surveyLink(w, sid, survey.id, p.id);
    assert.equal((await w.call('POST', 'public/survey/submit', { token, consent: true, noticeVersion: notice.version, answers: { q13: a } })).status, 200);
  }
  const coord = (await w.call('GET', `research/surveys/${survey.id}/results`, undefined, { cookie: csid })).body;
  assert.equal(coord.responses, 6);
  const q13 = coord.summary.find(q => q.id === 'q13');
  assert.equal(q13.counts.Maybe, '<5'); assert.equal(q13.counts.Yes, '<5', 'second cell hidden so "Maybe" cannot be worked out');
  const founder = (await w.call('GET', `research/surveys/${survey.id}/results`, undefined, { cookie: sid })).body;
  assert.deepEqual(founder.summary.find(q => q.id === 'q13').counts, { Yes: 5, Maybe: 1 });
});

test('R2-05: the public page needs the notice approved for the version the link was made under', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const { survey } = await researchReady(w, sid, csid);
  const p = await reviewedParticipant(w, sid, { firstName: 'Delta', email: 'delta@example.com' });
  const token = await surveyLink(w, sid, survey.id, p.id);
  await db.sql`UPDATE org_meta SET value = jsonb_set(value, '{version}', '"older"') WHERE key = 'research_notice'`;
  assert.equal((await w.call('POST', 'public/survey/load', { token })).status, 400);
});

// =============================== Third review (6052378857) ===============================
test('R3: an imported "no" to consent is recorded as intake but never counted as recruitment', async () => {
  const { w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  const r = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'f.csv', exportedAt: '2026-11-24', expectedCount: 2, consentEvidence: 'Archived form, Drive',
    records: [{ firstName: 'Echo', email: 'echo@example.com', sourceSubmissionId: 'e1', consent: { value: 'yes', version: 'v1' } }, { firstName: 'Foxtrot', email: 'foxtrot@example.com', sourceSubmissionId: 'f1', consent: { value: 'no', version: 'v1' } }] }, { cookie: sid });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const p of (await w.call('GET', 'participants', undefined, { cookie: sid })).body.participants)
    await w.call('PATCH', `participants/${p.id}`, { isTest: false, version: p.version }, { cookie: sid });
  const reg = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.metrics.find(m => m.id === 'registrations');
  assert.equal(reg.value, 1); assert.match(reg.definition, /1 registered without consent/);
  assert.equal(await count('cohort_memberships'), 1, 'no program membership without consent');
  assert.equal((await db.sql`SELECT consent FROM pilot_intake_records WHERE source_submission_id = 'f1'`)[0].consent.evidence, 'Archived form, Drive');
});

test('R3: the same submission with a different consent answer is held for review, not silently merged', async () => {
  const { w } = setup();
  const { sid } = await w.ready(FOUNDER_EMAIL);
  assert.equal(await ingestPilotSubmission(w.deps, FORM, '2026-11-24T16:00:00.000Z', { submissionId: 'same-1' }), 'created');
  const r = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'f.csv', exportedAt: '2026-11-24', expectedCount: 1, consentEvidence: 'Archived form',
    records: [{ firstName: 'Juliet', email: 'juliet@example.com', sourceSubmissionId: 'same-1', consent: { value: 'no', version: 'v1' } }] }, { cookie: sid });
  assert.equal(r.body.conflicts, 1); assert.equal(r.body.reconciled, false);
  // An export row that agrees on consent is the same registration.
  const ok = await w.call('POST', 'participants/import', { source: 'netlify_forms_export', exportRef: 'f2.csv', exportedAt: '2026-11-24', expectedCount: 1, consentEvidence: 'Archived form',
    records: [{ firstName: 'Juliet', email: 'juliet@example.com', sourceSubmissionId: 'same-1', consent: { value: 'yes', version: 'v1' } }] }, { cookie: sid });
  assert.equal(ok.body.alreadyImported, 1); assert.equal(ok.body.reconciled, true);
});

test('R3: a write queued behind a revocation is refused; a write already holding the lock commits first', async () => {
  // Revoke holds the member lock: the coordinator's write waits, then sees the revocation.
  let { b, w } = setup();
  let { sid, csid, coordId } = await team(w);
  let gate = b.arm('team.change.locked');
  const revoking = w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid });
  await gate.reached;
  const writing = w.call('POST', 'participants', { firstName: 'Golf' }, { cookie: csid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  await revoking;
  assert.equal((await writing).status, 401);
  assert.equal(await count('participants'), 0);

  // The coordinator's write already holds its share lock: the revoke waits for it to commit.
  await pgdb.reset();
  ({ b, w } = setup());
  ({ sid, csid, coordId } = await team(w));
  gate = b.arm('write.authority.checked');
  const write2 = w.call('POST', 'participants', { firstName: 'Hotel' }, { cookie: csid });
  await gate.reached;
  const revoke2 = w.call('PATCH', `team/${coordId}`, { action: 'revoke' }, { cookie: sid });
  await waitForLockWait(pgdb.pool);
  gate.release();
  assert.equal((await write2).status, 201); assert.equal((await revoke2).status, 200);
  assert.equal((await w.call('POST', 'participants', { firstName: 'India' }, { cookie: csid })).status, 401);
});

test('R3: decisions must carry the digest that was reviewed', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  await w.call('POST', 'approvals', { itemType: 'message', channel: 'email', to: 'Someone', message: 'Hello' }, { cookie: csid });
  const ap = (await w.call('GET', 'approvals', undefined, { cookie: sid })).body.approvals[0];
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved' }, { cookie: sid })).status, 400);
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: 'a'.repeat(64) }, { cookie: sid })).status, 409);
  assert.equal((await w.call('POST', `approvals/${ap.id}/decide`, { decision: 'approved', digest: ap.digest }, { cookie: sid })).status, 200);
});

test('R3: an email whose outcome is unknown is marked uncertain, not resent, and shown to the founder', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  let sends = 0;
  w.deps.sendMail = async () => { sends++; throw Object.assign(new Error('socket closed'), { code: 'ETIMEDOUT' }); };
  await w.call('POST', 'approvals', { itemType: 'message', channel: 'email', to: 'Someone', message: 'Hello' }, { cookie: csid });
  await w.call('POST', 'auth/logout', {});
  assert.equal(sends, 1, 'not retried');
  assert.equal((await db.sql`SELECT status FROM notifications_outbox`)[0].status, 'uncertain');
  const m = (await w.call('GET', 'dashboard', undefined, { cookie: sid })).body.metrics.find(x => x.id === 'emails');
  assert.equal(m.value, 1); assert.match(m.definition, /1 may or may not have been delivered/);
  // A row stuck in "sending" (process died mid-send) also becomes uncertain after 10 minutes.
  await db.sql`UPDATE notifications_outbox SET status = 'sending', last_attempt_at = ${new Date(w.clock - 11 * 60000).toISOString()}`;
  await w.call('POST', 'auth/logout', {});
  assert.equal((await db.sql`SELECT status FROM notifications_outbox`)[0].status, 'uncertain');
});

test('R3: switching research off closes survey links already sent; withdrawal still works; a changed notice needs consent again', async () => {
  const { w } = setup();
  const { sid, csid } = await team(w);
  const { survey, notice } = await researchReady(w, sid, csid);
  const p = await reviewedParticipant(w, sid, { firstName: 'Kilo', email: 'kilo@example.com' });
  const token = await surveyLink(w, sid, survey.id, p.id);
  w.deps.features = new Set();
  assert.equal((await w.call('POST', 'public/survey/load', { token })).status, 400);
  assert.equal((await w.call('POST', 'public/survey/submit', { token, consent: true, noticeVersion: notice.version, answers: { q4: 3 } })).status, 400);
  w.deps.features = new Set(['research']);
  const p2 = await reviewedParticipant(w, sid, { firstName: 'Lima', email: 'lima2@example.com' });
  const t2 = await surveyLink(w, sid, survey.id, p2.id);
  // Consent given under an older notice version doesn't count for the current one.
  await db.sql`INSERT INTO research_consents (id, org_id, participant_id, purpose, notice_version, method, given_at, recorded_by) VALUES ('rcn_old', 'spinfamily', ${p2.id}, 'pilot_research', 'older-notice', 'founder_recorded_written', now(), 'x')`;
  assert.equal((await w.call('POST', 'public/survey/load', { token: t2 })).body.consentOnFile, false);
  assert.equal((await w.call('POST', 'public/survey/submit', { token: t2, answers: { q4: 3 } })).body.error.code, 'consent_required');
  assert.equal((await w.call('POST', 'public/survey/submit', { token: t2, consent: true, noticeVersion: notice.version, answers: { q4: 3 } })).status, 200);
  w.deps.features = new Set();
  assert.equal((await w.call('POST', 'public/survey/withdraw', { token })).status, 200, 'withdrawal works with research switched off');
});
