// Recruitment operations: participants, pilot-form intake, follow-ups, outreach log, relationships, dashboard.
import { normalizeEmail, sha256 } from './security.mjs';
import { parsePilot } from '../pilot-welcome.mjs';
import { json, notFound, Invalid, newId, iso, text, oneOf, date, count, maskEmail, row, rows, asJson } from './util.mjs';
import { memberById } from './core.mjs';
import { inTx, barrier } from './db.mjs';

export const REFS = ['instagram', 'facebook', 'fbgroups', 'tiktok', 'lindsey', 'campus', 'campus-groups', 'direct', 'other', 'unknown'];
class Conflict extends Error { constructor() { super('conflict'); this.conflict = true; } }
export const STATES = {
  cohort: ['pilot', 'beta', 'research', 'prospect'],
  enrollment: ['prospect', 'registration_received', 'eligibility_confirmed', 'enrolled', 'withdrawn', 'archived'],
  account: ['unknown', 'not_found', 'created', 'confirmation_pending', 'confirmed', 'disabled'],
  engagement: ['unknown', 'not_started', 'first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed', 'survey_submitted', 'pilot_completed'],
  communication: ['unknown', 'not_sent', 'queued', 'smtp_accepted', 'delivery_confirmed', 'bounced', 'failed', 'uncertain', 'opted_out'],
};
const STAGES = ['identified', 'contacted', 'meeting_scheduled', 'in_conversation', 'paused', 'closed'];
const FOLLOWUP_STATUS = ['open', 'done', 'cancelled'];

export async function recordRoutes(parts, method, body, env) {
  const sub = parts.slice(1);
  switch (parts[0]) {
    case 'dashboard': return method === 'GET' ? dashboard(env) : null;
    case 'participants': return participants(sub, method, body, env);
    case 'followups': return followups(sub, method, body, env);
    case 'outreach': return outreach(sub, method, body, env);
    case 'relationships': return relationships(sub, method, body, env);
  }
  return null;
}

// ---------- Participants ----------
const toParticipant = r => {
  const p = row(r);
  return { id: p.id, firstName: p.first_name, email: p.email, cohort: p.cohort, enrollment: p.enrollment, account: p.account, engagement: p.engagement, communication: p.communication, technicalSource: p.technical_source, heardFrom: p.heard_from, reportedSource: p.reported_source,
    verified: { account: p.account_verified, engagement: p.engagement_verified, communication: p.communication_verified }, version: p.version, assignedTo: p.assigned_to, isTest: p.is_test, origin: p.origin, intake: p.intake, notes: p.notes, householdKey: p.household_key || null, withdrawnAt: p.withdrawn_at || null, createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at };
};
export function viewParticipant(p, env) {
  const showContact = env.has('participants.contact.all') || p.assignedTo === env.member.id;
  return { ...p, email: showContact ? p.email : maskEmail(p.email), emailMasked: !showContact && !!p.email };
}
export const PAGE_MAX = 200;
export function page(q = {}) {
  const limit = Math.min(PAGE_MAX, Math.max(1, Number.parseInt(q.limit, 10) || PAGE_MAX));
  const offset = Math.min(1e6, Math.max(0, Number.parseInt(q.offset, 10) || 0));
  return { limit, offset };
}
export async function visibleParticipants(env, { limit = PAGE_MAX, offset = 0 } = {}) {
  const all = env.has('participants.view.all');
  const r = await env.sql`SELECT * FROM participants WHERE org_id = ${env.orgId} AND (${all} OR assigned_to = ${env.member.id}) ORDER BY created_at DESC, id LIMIT ${limit + 1} OFFSET ${offset}`;
  const list = r.slice(0, limit).map(toParticipant);
  list.more = r.length > limit;
  return list;
}
export async function getParticipant(env, id) {
  const r = (await env.sql`SELECT * FROM participants WHERE id = ${id} AND org_id = ${env.orgId}`)[0];
  if (!r) return null;
  const p = toParticipant(r);
  return env.has('participants.view.all') || p.assignedTo === env.member.id ? p : null;
}
async function history(env, pid, actor, changes) {
  if (changes.length) await env.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${env.orgId}, ${pid}, ${iso(env.now())}, ${actor}, ${asJson(changes)}::jsonb)`;
}

async function participants(parts, method, body, env) {
  const me = env.member;
  if (method === 'GET' && !parts.length) {
    env.need('participants.view.assigned');
    const pg = page(env.query);
    const list = await visibleParticipants(env, pg);
    return json({ participants: list.map(p => viewParticipant(p, env)), page: { ...pg, more: list.more }, states: STATES, refs: REFS, scope: env.has('participants.view.all') ? 'all' : 'assigned' });
  }
  if (method === 'POST' && !parts.length) {
    env.need('participants.create');
    const email = body.email ? normalizeEmail(body.email) : '';
    if (body.email && !email) throw new Invalid('Email address is not valid');
    if (email && (await env.sql`SELECT 1 FROM participants WHERE org_id = ${env.orgId} AND email = ${email}`)[0]) throw new Invalid('A participant with that email already exists');
    let assignedTo = me.role === 'coordinator' ? me.id : null;
    if (me.role !== 'coordinator' && body.assignedTo) {
      env.need('participants.assign'); // same check as reassigning later (IR-05)
      const m = await memberById(env, body.assignedTo);
      if (!m || m.status === 'revoked') throw new Invalid('Unknown team member');
      assignedTo = m.id;
    }
    if (body.cohort && !['prospect', 'pilot'].includes(body.cohort)) env.need('participants.verify');
    const now = iso(env.now()), id = newId('p');
    const p = {
      firstName: text(body.firstName, 'First name', 60, { required: true }),
      cohort: oneOf(body.cohort, 'cohort', STATES.cohort, 'prospect'), enrollment: oneOf(body.enrollment, 'enrollment', STATES.enrollment, 'prospect'),
      account: oneOf(body.account, 'account', STATES.account, 'unknown'), engagement: oneOf(body.engagement, 'engagement', STATES.engagement, 'unknown'),
      communication: oneOf(body.communication, 'communication', STATES.communication, 'unknown'), reportedSource: oneOf(body.reportedSource, 'reported source', REFS, 'unknown'),
      notes: text(body.notes, 'notes', 1000),
    };
    await inTx(env, async t => {
      await t.sql`INSERT INTO participants (id, org_id, first_name, email, cohort, enrollment, account, engagement, communication, technical_source, reported_source, assigned_to, is_test, origin, intake, notes, created_by, created_at, updated_at)
        VALUES (${id}, ${t.orgId}, ${p.firstName}, ${email}, ${p.cohort}, ${p.enrollment}, ${p.account}, ${p.engagement}, ${p.communication}, NULL, ${p.reportedSource}, ${assignedTo}, false, 'manual', NULL, ${p.notes}, ${me.id}, ${now}, ${now})`;
      await history(t, id, me.id, [{ field: 'created', to: p.enrollment }]);
      await t.audit('participant.created', id);
    });
    return json({ participant: viewParticipant(await getParticipant(env, id), env) }, 201);
  }
  if (method === 'POST' && parts[0] === 'import') return importParticipants(body, env);
  if (parts[0] === 'backfill') return backfill(method, body, env);
  if (parts[0] === 'intake-conflicts') return intakeConflicts(parts.slice(1), method, body, env);
  if (parts[0]) {
    const p = await getParticipant(env, parts[0]);
    if (!p) return notFound();
    if (method === 'GET') {
      const h = rows(await env.sql`SELECT at, actor, changes FROM participant_history WHERE participant_id = ${p.id} ORDER BY id DESC LIMIT 200`).reverse();
      const programs = rows(await env.sql`SELECT cohort, status, evidence_kind, joined_at, left_at FROM cohort_memberships WHERE participant_id = ${p.id} AND org_id = ${env.orgId} ORDER BY joined_at`);
      return json({ participant: viewParticipant(p, env), history: h, programs: programs.map(c => ({ cohort: c.cohort, status: c.status, evidence: c.evidence_kind, joinedAt: c.joined_at, leftAt: c.left_at })) });
    }
    if (method === 'POST' && parts[1] === 'withdraw') return withdrawParticipant(p, body, env);
    if (method === 'POST' && parts[1] === 'redact') return redactParticipant(p, body, env);
    if (method === 'PATCH') {
      env.need('participants.update.assigned');
      if (body.technicalSource !== undefined || body.email !== undefined || body.heardFrom !== undefined) throw new Invalid('Email and form sources can only be changed by the founder through a data correction');
      if (!Number.isInteger(body.version)) throw new Invalid('Missing version: reload and try again');
      const isFounderVerify = env.has('participants.verify');
      const changes = [], next = { ...p, verified: { ...p.verified } };
      const setField = (f, v) => { if (v !== undefined && v !== p[f]) { changes.push({ field: f, from: p[f], to: v }); next[f] = v; } };
      if (body.cohort !== undefined) { env.need('participants.verify'); setField('cohort', oneOf(body.cohort, 'cohort', STATES.cohort)); }
      if (body.householdKey !== undefined) { env.need('participants.verify'); setField('householdKey', text(body.householdKey, 'Household', 40) || null); }
      // IR-03: anything a person types is a field report. Only the founder, with a stated source, can mark a state verified.
      const verify = body.verify && typeof body.verify === 'object' ? body.verify : {};
      const evidence = text(body.evidenceNote, 'Evidence', 300);
      for (const f of ['account', 'engagement', 'communication']) {
        if (body[f] !== undefined) {
          const v = oneOf(body[f], f, STATES[f]);
          if (v !== p[f]) { setField(f, v); next.verified[f] = false; }
        }
        if (verify[f] === true) {
          env.need('participants.verify');
          if (!evidence) throw new Invalid('Say how you verified it (for example "Checked Netlify Identity on Nov 26")');
          if (next[f] === 'unknown') throw new Invalid(`Choose the ${f} state before verifying it`);
          if (!next.verified[f] || next[f] !== p[f]) { changes.push({ field: `${f} verified`, to: `${next[f]} (${evidence})` }); next.verified[f] = true; }
        }
      }
      void isFounderVerify;
      if (body.enrollment !== undefined) {
        const v = oneOf(body.enrollment, 'enrollment', STATES.enrollment);
        if (v === 'withdrawn') throw new Invalid('Use "Record withdrawal" so links, consent and programs are updated together');
        setField('enrollment', v);
      }
      if (body.reportedSource !== undefined) setField('reportedSource', oneOf(body.reportedSource, 'reported source', REFS));
      if (body.notes !== undefined) setField('notes', text(body.notes, 'notes', 1000));
      if (body.firstName !== undefined) setField('firstName', text(body.firstName, 'First name', 60, { required: true }));
      if (body.assignedTo !== undefined) {
        env.need('participants.assign');
        if (body.assignedTo !== null) { const m = await memberById(env, body.assignedTo); if (!m || m.status === 'revoked') throw new Invalid('Unknown team member'); }
        setField('assignedTo', body.assignedTo);
      }
      if (body.isTest !== undefined) { env.need('participants.markTest'); setField('isTest', !!body.isTest); }
      if (!changes.length) return json({ participant: viewParticipant(p, env) });
      // IR-05: compare-and-set on the version the editor saw, and re-check scope in the same statement,
      // so a stale screen can't undo a newer change or touch a record that was reassigned meanwhile.
      if (p.withdrawnAt) throw new Invalid('This person withdrew. Their record can no longer be changed.');
      const cohortChange = changes.find(c => c.field === 'cohort');
      if (cohortChange && ['pilot', 'beta', 'research'].includes(next.cohort) && !evidence) throw new Invalid('Say what shows they joined (for example "Signed up in person at the Nov 20 event")');
      const all = env.has('participants.view.all');
      const nameOf = async id => id ? ((await memberById(env, id))?.name || 'former member') : 'nobody';
      const logged = [];
      for (const c of changes) {
        if (c.field === 'notes') logged.push({ field: 'notes', to: '(edited)' });
        else if (c.field === 'assignedTo') logged.push({ field: 'assigned to', from: await nameOf(c.from), to: await nameOf(c.to) });
        else logged.push(c);
      }
      // Record, history, program membership and audit are one transaction (R2-03).
      await inTx(env, async t => {
        const updated = await t.sql`UPDATE participants SET first_name = ${next.firstName}, cohort = ${next.cohort}, enrollment = ${next.enrollment}, account = ${next.account}, engagement = ${next.engagement}, communication = ${next.communication},
          account_verified = ${next.verified.account}, engagement_verified = ${next.verified.engagement}, communication_verified = ${next.verified.communication},
          reported_source = ${next.reportedSource}, assigned_to = ${next.assignedTo}, is_test = ${next.isTest}, household_key = ${next.householdKey}, notes = ${next.notes}, updated_at = ${iso(t.now())}, version = version + 1
          WHERE id = ${p.id} AND org_id = ${t.orgId} AND version = ${body.version} AND withdrawn_at IS NULL AND (${all} OR assigned_to = ${me.id}) RETURNING id`;
        if (!updated[0]) throw new Conflict();
        if (cohortChange && ['pilot', 'beta', 'research'].includes(next.cohort))
          await t.sql`INSERT INTO cohort_memberships (org_id, participant_id, cohort, status, evidence_kind, evidence_ref, joined_at, recorded_by) VALUES (${t.orgId}, ${p.id}, ${next.cohort}, 'active', 'founder_record', ${evidence}, ${iso(t.now())}, ${me.id})
            ON CONFLICT (org_id, participant_id, cohort) DO NOTHING`;
        await history(t, p.id, me.id, logged);
        await t.audit('participant.updated', p.id, { fields: changes.map(c => c.field) });
      });
      return json({ participant: viewParticipant(await getParticipant(env, p.id), env) });
    }
  }
  return notFound();
}

// ---------- Intake ledger (IR-04, R2-03) ----------
// Every registration, live or imported, becomes one append-only ledger row with its provenance and
// consent. Ledger row, participant, program membership and history are written in one transaction,
// so a failure part-way leaves nothing behind and a retry starts clean. The same source submission
// id arriving with different content is held for founder review and never merged.
export const PILOT_CONSENT_TEXT = 'SpinFamily may email me about the family pilot. I can opt out anytime. See our privacy policy.';
export const PILOT_CONSENT_VERSION = `pilot-form:${sha256(PILOT_CONSENT_TEXT).slice(0, 12)}`; // tests check this text is still what the form shows
const PILOT_CONSENT = { purpose: 'pilot_email', value: 'yes', version: PILOT_CONSENT_VERSION };

async function recordIntake(deps, x) {
  return inTx(deps, async t => {
    // Serialize everything about the same submission and the same person.
    if (x.submissionId) await t.sql`SELECT pg_advisory_xact_lock(hashtext(${`intake-id:${t.orgId}:${x.submissionId}`}))`;
    await t.sql`SELECT pg_advisory_xact_lock(hashtext(${`intake-email:${t.orgId}:${x.email}`}))`;
    const payloadHash = sha256(JSON.stringify([x.email, x.firstName, x.source, x.heardFrom, x.children ?? null, x.submissionId, x.cohort]));
    if (x.submissionId) {
      const prior = (await t.sql`SELECT r.id, r.payload_hash, r.provenance, p.email FROM pilot_intake_records r LEFT JOIN participants p ON p.id = r.participant_id WHERE r.org_id = ${t.orgId} AND r.source_submission_id = ${x.submissionId}`)[0];
      if (prior && prior.payload_hash === payloadHash) return 'duplicate_event';
      // An export row for a submission the live form already delivered differs only in which fields the
      // export carries: same id, same person is the same registration. Anything else is held for review.
      if (prior && (prior.provenance === 'founder_import') !== (x.provenance === 'founder_import') && prior.email === x.email) return 'duplicate_event';
      if (prior) {
        await t.sql`INSERT INTO intake_conflicts (id, org_id, source_submission_id, existing_record_id, payload_hash, provenance, receipt_id, received_at, status)
          VALUES (${newId('ic')}, ${t.orgId}, ${x.submissionId}, ${prior.id}, ${payloadHash}, ${x.provenance}, ${x.receiptId}, ${x.nowIso}, 'open') ON CONFLICT DO NOTHING`;
        return 'conflict';
      }
    } else if ((await t.sql`SELECT 1 FROM pilot_intake_records WHERE org_id = ${t.orgId} AND payload_hash = ${payloadHash}`)[0]) return 'duplicate_event';

    let outcome = 'created';
    let person = (await t.sql`SELECT id, cohort, enrollment, technical_source, withdrawn_at FROM participants WHERE org_id = ${t.orgId} AND email = ${x.email} FOR UPDATE`)[0];
    const pid = person?.id || newId('p');
    if (!person) {
      await t.sql`INSERT INTO participants (id, org_id, first_name, email, cohort, enrollment, account, engagement, communication, technical_source, heard_from, reported_source, assigned_to, is_test, origin, intake, notes, created_by, created_at, updated_at)
        VALUES (${pid}, ${t.orgId}, ${x.firstName}, ${x.email}, ${x.cohort}, ${x.cohort === 'pilot' ? 'registration_received' : 'enrolled'}, ${x.cohort === 'beta' ? 'created' : 'unknown'}, 'unknown', 'unknown', ${x.source}, ${x.heardFrom}, 'unknown', NULL, NULL, ${x.origin}, ${asJson(x.intake)}::jsonb, '', ${x.actor}, ${x.createdAt || x.nowIso}, ${x.nowIso})`;
    } else if (person.withdrawn_at) {
      outcome = 'linked_existing'; // they withdrew earlier: record the event, change nothing about them
    } else if (person.cohort === 'prospect' || (!person.technical_source && x.source)) {
      // Someone the team added by hand has now registered: promote them and keep the form source.
      await t.sql`UPDATE participants SET cohort = CASE WHEN cohort = 'prospect' THEN ${x.cohort} ELSE cohort END,
        enrollment = CASE WHEN enrollment = 'prospect' THEN 'registration_received' ELSE enrollment END,
        technical_source = coalesce(technical_source, ${x.source}), heard_from = coalesce(heard_from, ${x.heardFrom}),
        intake = coalesce(intake, ${asJson(x.intake)}::jsonb), updated_at = ${x.nowIso}, version = version + 1 WHERE id = ${pid}`;
      outcome = 'promoted_prospect';
    } else outcome = 'linked_existing';
    await barrier(t, 'intake.after_participant');
    const ledgerId = newId('in');
    await t.sql`INSERT INTO pilot_intake_records (id, org_id, source_submission_id, payload_hash, source_timestamp, received_at, provenance, consent, technical_source, heard_from, participant_id, outcome, receipt_id, cohort)
      VALUES (${ledgerId}, ${t.orgId}, ${x.submissionId}, ${payloadHash}, ${x.sourceTs}, ${x.nowIso}, ${x.provenance}, ${asJson(x.consent)}::jsonb, ${x.source}, ${x.heardFrom}, ${pid}, ${outcome}, ${x.receiptId}, ${x.cohort})`;
    if (!person?.withdrawn_at)
      await t.sql`INSERT INTO cohort_memberships (org_id, participant_id, cohort, status, evidence_kind, evidence_ref, joined_at, recorded_by)
        VALUES (${t.orgId}, ${pid}, ${x.cohort}, 'active', ${x.provenance === 'founder_import' ? 'founder_import' : 'pilot_form'}, ${ledgerId}, ${x.sourceTs || x.nowIso}, ${x.actor})
        ON CONFLICT (org_id, participant_id, cohort) DO NOTHING`;
    await barrier(t, 'intake.before_history');
    await t.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${t.orgId}, ${pid}, ${x.nowIso}, ${x.actor}, ${asJson([{ field: 'intake', to: `${outcome} (${x.provenance === 'founder_import' ? 'imported' : 'link source: ' + x.source})` }])}::jsonb)`;
    return outcome;
  });
}

export async function ingestPilotSubmission(deps, data, nowIso, meta = {}) {
  const parsed = parsePilot(data);
  if (!parsed) return 'skipped_invalid';
  const submissionId = typeof meta.submissionId === 'string' && /^[\w-]{1,64}$/.test(meta.submissionId) ? meta.submissionId : null;
  const sourceTs = typeof meta.submittedAt === 'string' && !Number.isNaN(Date.parse(meta.submittedAt)) ? new Date(meta.submittedAt).toISOString() : null;
  const heardFrom = typeof data.heard_from === 'string' ? data.heard_from.trim().slice(0, 80) || null : null;
  return recordIntake(deps, {
    email: parsed.email, firstName: parsed.firstName, source: data.source, heardFrom, children: data.children_under_10,
    submissionId, sourceTs, nowIso, cohort: 'pilot', provenance: submissionId ? 'event_with_id' : 'event_without_id', consent: PILOT_CONSENT,
    receiptId: null, actor: 'pilot-form', origin: 'pilot-form', intake: { form: 'pilot', receivedAt: nowIso, submissionId, childrenUnder10: data.children_under_10 },
  });
}

// IR-09 / R2-03: founder-only backfill of records from before this workspace. Each call names the
// export it came from and how many rows that export holds; it writes a receipt that says whether
// the rows reconcile. Every row needs its source id (form submission id or app account id) and the
// consent it was given under. The whole import is one transaction.
const IMPORT_SOURCES = ['netlify_forms_export', 'app_identity_export', 'founder_records'];
export const REQUIRED_BACKFILL_SOURCES = ['netlify_forms_export', 'app_identity_export'];
async function importParticipants(body, env) {
  env.need('participants.verify');
  const source = oneOf(body.source, 'source', IMPORT_SOURCES);
  const exportedAt = date(body.exportedAt, 'export date');
  if (!exportedAt) throw new Invalid('Say when the export was made');
  const exportRef = text(body.exportRef, 'Export file or id', 200, { required: true });
  const exportSha = body.exportSha256 ? text(body.exportSha256, 'Export checksum', 64) : null;
  if (exportSha && !/^[a-f0-9]{64}$/.test(exportSha)) throw new Invalid('Export checksum must be a SHA-256 hex value');
  const expected = count(body.expectedCount, 'Rows in the export', 10000);
  if (expected === null) throw new Invalid('Say how many rows the export has (0 if none)');
  if (!Array.isArray(body.records) || body.records.length > 200) throw new Invalid('Send up to 200 records');
  const rowsIn = body.records.map((r, i) => {
    const n = `Row ${i + 1}`;
    const email = normalizeEmail(r?.email);
    if (!email) throw new Invalid(`${n}: email is not valid`);
    const firstName = text(r?.firstName, `${n} first name`, 60, { required: true });
    const sourceId = r.sourceSubmissionId ? text(r.sourceSubmissionId, `${n} source id`, 64) : '';
    if (sourceId && !/^[\w-]{1,64}$/.test(sourceId)) throw new Invalid(`${n}: source id has invalid characters`);
    if (source !== 'founder_records' && !sourceId) throw new Invalid(`${n}: the ${source === 'netlify_forms_export' ? 'form submission id' : 'app account id'} is required`);
    const cohort = oneOf(r.cohort, `${n} cohort`, ['pilot', 'beta'], source === 'app_identity_export' ? 'beta' : 'pilot');
    let consent;
    if (source === 'app_identity_export') consent = { purpose: 'app_account', value: 'not_applicable', version: null };
    else {
      const value = oneOf(r.consent?.value, `${n} consent`, ['yes', 'no']);
      const version = text(r.consent?.version, `${n} consent version`, 80, { required: true });
      consent = { purpose: 'pilot_email', value, version };
    }
    const submittedAt = r.submittedAt && !Number.isNaN(Date.parse(r.submittedAt)) ? new Date(r.submittedAt).toISOString() : null;
    const techSource = typeof r.source === 'string' && /^[\w-]{1,40}$/.test(r.source) ? r.source : null;
    return { email, firstName, sourceId: sourceId || null, cohort, consent, submittedAt, techSource };
  });
  const receiptId = newId('rcpt');
  const result = await inTx(env, async t => {
    const now = iso(t.now());
    // Receipt first (outcomes filled in below), so ledger rows can point at it.
    await t.sql`INSERT INTO backfill_receipts (id, org_id, source, export_ref, export_sha256, exported_at, expected_count, received_count, created_count, linked_count, duplicate_count, conflict_count, reconciled, created_by, created_at)
      VALUES (${receiptId}, ${t.orgId}, ${source}, ${exportRef}, ${exportSha}, ${exportedAt}, ${expected}, ${rowsIn.length}, 0, 0, 0, 0, false, ${t.member.id}, ${now})`;
    const tally = { created: 0, linked_existing: 0, promoted_prospect: 0, duplicate_event: 0, conflict: 0 };
    for (const r of rowsIn) {
      const outcome = await recordIntake(t, {
        email: r.email, firstName: r.firstName, source: r.techSource, heardFrom: null, children: null, submissionId: !r.sourceId ? null : source === 'netlify_forms_export' ? r.sourceId : `${source === 'app_identity_export' ? 'app' : 'founder'}:${r.sourceId}`,
        sourceTs: r.submittedAt, nowIso: now, cohort: r.cohort, provenance: 'founder_import', consent: r.consent, receiptId, actor: t.member.id,
        origin: `import:${source}`, createdAt: r.submittedAt, intake: { form: source === 'netlify_forms_export' ? 'pilot' : null, importedFrom: source, exportRef, exportedAt, submittedAt: r.submittedAt, importedBy: t.member.id },
      });
      tally[outcome]++;
    }
    const linked = tally.linked_existing + tally.promoted_prospect;
    const reconciled = rowsIn.length === expected && tally.conflict === 0;
    await t.sql`UPDATE backfill_receipts SET created_count = ${tally.created}, linked_count = ${linked}, duplicate_count = ${tally.duplicate_event}, conflict_count = ${tally.conflict}, reconciled = ${reconciled} WHERE id = ${receiptId}`;
    await t.audit('participants.imported', receiptId, { source, rows: rowsIn.length, expected, reconciled });
    return { receiptId, created: tally.created, linked, alreadyImported: tally.duplicate_event, conflicts: tally.conflict, expected, received: rowsIn.length, reconciled };
  });
  return json(result, 201);
}

async function backfill(method, body, env) {
  env.need('participants.verify');
  const receipts = rows(await env.sql`SELECT id, source, export_ref, exported_at::text AS exported_at, expected_count, received_count, created_count, linked_count, duplicate_count, conflict_count, reconciled, created_at FROM backfill_receipts WHERE org_id = ${env.orgId} ORDER BY created_at DESC LIMIT 100`);
  const state = (await env.sql`SELECT value FROM org_meta WHERE org_id = ${env.orgId} AND key = 'backfill'`)[0]?.value || null;
  if (method === 'GET') return json({ receipts, complete: state, requiredSources: REQUIRED_BACKFILL_SOURCES });
  if (method !== 'POST') return notFound();
  // Completion needs one reconciled receipt for every required source, and no open conflicts.
  const chosen = Array.isArray(body.receiptIds) ? body.receiptIds.map(String) : [];
  const picked = receipts.filter(r => chosen.includes(r.id));
  const missing = REQUIRED_BACKFILL_SOURCES.filter(src => !picked.some(r => r.source === src && r.reconciled));
  if (missing.length) throw new Invalid(`Backfill can't be marked complete yet: needs a reconciled import for ${missing.join(' and ')}`);
  const open = (await env.sql`SELECT count(*)::int AS n FROM intake_conflicts WHERE org_id = ${env.orgId} AND status = 'open'`)[0].n;
  if (open) throw new Invalid(`Resolve the ${open} held registration conflict${open === 1 ? '' : 's'} first`);
  const value = { completeAt: iso(env.now()), by: env.member.id, receipts: picked.map(r => r.id) };
  await inTx(env, async t => {
    await t.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${t.orgId}, 'backfill', ${asJson(value)}::jsonb) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`;
    await t.audit('participants.backfill_complete', null, { receipts: value.receipts });
  });
  return json({ complete: value });
}

async function intakeConflicts(parts, method, body, env) {
  env.need('participants.verify');
  if (method === 'GET' && !parts.length) {
    const list = rows(await env.sql`SELECT c.id, c.source_submission_id, c.provenance, c.received_at, c.status, c.resolution, c.existing_record_id, r.participant_id FROM intake_conflicts c JOIN pilot_intake_records r ON r.id = c.existing_record_id WHERE c.org_id = ${env.orgId} ORDER BY c.received_at DESC LIMIT 200`);
    return json({ conflicts: list.map(c => ({ id: c.id, sourceSubmissionId: c.source_submission_id, provenance: c.provenance, receivedAt: c.received_at, status: c.status, resolution: c.resolution, participantId: c.participant_id })) });
  }
  if (method === 'POST' && parts[0] && parts[1] === 'resolve') {
    const note = text(body.resolution, 'What you found', 500, { required: true });
    const done = await inTx(env, async t => {
      const r = await t.sql`UPDATE intake_conflicts SET status = 'resolved', resolution = ${note}, resolved_by = ${t.member.id}, resolved_at = ${iso(t.now())} WHERE id = ${parts[0]} AND org_id = ${t.orgId} AND status = 'open' RETURNING id`;
      if (r[0]) await t.audit('intake.conflict_resolved', parts[0]);
      return !!r[0];
    });
    if (!done) return notFound();
    return json({ ok: true });
  }
  return notFound();
}

// ---------- Withdrawal and governed redaction (IR-06, R2-03, R2-05) ----------
// Withdrawal stops everything going forward: programs, research consent, open survey links.
async function withdrawParticipant(p, body, env) {
  env.need('participants.update.assigned');
  const note = text(body.note, 'How they asked', 300, { required: true });
  const all = env.has('participants.view.all');
  await inTx(env, async t => {
    const r = await t.sql`UPDATE participants SET withdrawn_at = ${iso(t.now())}, enrollment = 'withdrawn', updated_at = ${iso(t.now())}, version = version + 1
      WHERE id = ${p.id} AND org_id = ${t.orgId} AND withdrawn_at IS NULL AND (${all} OR assigned_to = ${t.member.id}) RETURNING id`;
    if (!r[0]) throw new Conflict();
    await withdrawEverywhere(t, p.id, 'team_recorded', t.member.id);
    await history(t, p.id, t.member.id, [{ field: 'withdrawn', to: note }]);
    await t.audit('participant.withdrawn', p.id);
  });
  return json({ participant: viewParticipant(await getParticipant(env, p.id), env) });
}
export async function withdrawEverywhere(t, participantId, method, by) {
  const at = iso(t.now());
  await t.sql`UPDATE cohort_memberships SET status = 'withdrawn', left_at = ${at} WHERE org_id = ${t.orgId} AND participant_id = ${participantId} AND status = 'active'`;
  await t.sql`UPDATE research_enrollments SET status = 'withdrawn' WHERE org_id = ${t.orgId} AND participant_id = ${participantId}`;
  await t.sql`UPDATE research_consents SET withdrawn_at = ${at}, withdrawal_method = ${method}, withdrawal_by = ${by} WHERE org_id = ${t.orgId} AND participant_id = ${participantId} AND withdrawn_at IS NULL`;
  await t.sql`UPDATE survey_invites SET revoked_at = ${t.now()} WHERE org_id = ${t.orgId} AND participant_id = ${participantId} AND used_at IS NULL AND revoked_at IS NULL`;
  await t.sql`INSERT INTO research_withdrawals (id, org_id, participant_id, method, recorded_by, at) VALUES (${newId('rw')}, ${t.orgId}, ${participantId}, ${method}, ${by}, ${at})`;
}

// Founder-only. Removes a person's identifying details everywhere, including the append-only
// history, intake and survey tables (allowed only inside this transaction), and records that it
// happened. Counts stay correct; the person can no longer be identified from the workspace.
async function redactParticipant(p, body, env) {
  env.need('participants.redact');
  const reason = oneOf(body.reason, 'reason', ['participant_request', 'retention_expired', 'entered_in_error']);
  const requestRef = text(body.requestRef, 'Request reference', 200);
  if (body.confirm !== 'REDACT') throw new Invalid('Type REDACT to confirm. This cannot be undone.');
  const counts = await inTx(env, async t => {
    const at = iso(t.now());
    await t.sql`SELECT set_config('ops.redaction', 'on', true)`;
    const c = {};
    c.participant = (await t.sql`UPDATE participants SET first_name = '[redacted]', email = '', notes = '', intake = NULL, heard_from = NULL, household_key = NULL,
      withdrawn_at = coalesce(withdrawn_at, ${at}), enrollment = 'withdrawn', updated_at = ${at}, version = version + 1 WHERE id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    await withdrawEverywhere(t, p.id, 'redaction', t.member.id);
    c.history = (await t.sql`UPDATE participant_history SET changes = '[{"field":"redacted"}]'::jsonb WHERE participant_id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    c.intake = (await t.sql`UPDATE pilot_intake_records SET heard_from = NULL WHERE participant_id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    c.surveyResponses = (await t.sql`UPDATE survey_responses SET answers = '{}'::jsonb WHERE participant_id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    c.researchSessions = (await t.sql`UPDATE research_sessions SET observations = '' WHERE participant_id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    c.consents = (await t.sql`UPDATE research_consents SET evidence = '' WHERE participant_id = ${p.id} AND org_id = ${t.orgId} RETURNING id`).length;
    await t.sql`INSERT INTO redaction_events (id, org_id, participant_id, reason, request_ref, performed_by, performed_at, counts) VALUES (${newId('rd')}, ${t.orgId}, ${p.id}, ${reason}, ${requestRef}, ${t.member.id}, ${at}, ${asJson(c)}::jsonb)`;
    await t.audit('participant.redacted', p.id, { reason });
    return c;
  });
  return json({ ok: true, counts });
}

// ---------- Follow-ups ----------
const toFollowup = r => { const f = row(r); return { id: f.id, title: f.title, subjectType: f.subject_type, subjectId: f.subject_id, dueDate: f.due_date, assignedTo: f.assigned_to, status: f.status, outcome: f.outcome, createdAt: f.created_at, updatedAt: f.updated_at, completedAt: f.completed_at }; };
const FU_SELECT = 'id, title, subject_type, subject_id, due_date::text AS due_date, assigned_to, status, outcome, created_at, updated_at, completed_at';
void FU_SELECT;
export async function listFollowups(env, { openOnly = false } = {}) {
  const all = env.has('followups.view.all');
  const r = await env.sql`SELECT id, title, subject_type, subject_id, due_date::text AS due_date, assigned_to, status, outcome, created_at, updated_at, completed_at FROM followups
    WHERE org_id = ${env.orgId} AND (${all} OR assigned_to = ${env.member.id}) AND (${!openOnly} OR status = 'open') ORDER BY due_date NULLS LAST, created_at LIMIT 500`;
  return r.map(toFollowup);
}
async function followups(parts, method, body, env) {
  const me = env.member;
  env.need('followups.manage');
  if (method === 'GET' && !parts.length) return json({ followups: await listFollowups(env) });
  if (method === 'POST' && !parts.length) {
    const subjectType = oneOf(body.subjectType, 'subject type', ['participant', 'relationship', 'general'], 'general');
    const subjectId = subjectType === 'general' ? null : text(body.subjectId, 'subject', 40, { required: true });
    if (subjectType === 'participant' && !(await getParticipant(env, subjectId))) throw new Invalid('Unknown record');
    if (subjectType === 'relationship' && !(await env.sql`SELECT 1 FROM relationships WHERE id = ${subjectId} AND org_id = ${env.orgId}`)[0]) throw new Invalid('Unknown record');
    let assignedTo = me.id;
    if (body.assignedTo && body.assignedTo !== me.id) {
      if (me.role !== 'founder') throw new Invalid('You can only assign follow-ups to yourself');
      const m = await memberById(env, body.assignedTo); if (!m || m.status === 'revoked') throw new Invalid('Unknown team member');
      assignedTo = m.id;
    }
    const now = iso(env.now()), id = newId('f');
    await env.sql`INSERT INTO followups (id, org_id, title, subject_type, subject_id, due_date, assigned_to, status, created_by, created_at, updated_at)
      VALUES (${id}, ${env.orgId}, ${text(body.title, 'What needs to happen', 200, { required: true })}, ${subjectType}, ${subjectId}, ${date(body.dueDate, 'due date')}, ${assignedTo}, 'open', ${me.id}, ${now}, ${now})`;
    await env.audit('followup.created', id);
    return json({ followup: (await listFollowups(env)).find(f => f.id === id) }, 201);
  }
  if (method === 'PATCH' && parts[0]) {
    const f = (await listFollowups(env)).find(x => x.id === parts[0]);
    if (!f) return notFound();
    const status = body.status !== undefined ? oneOf(body.status, 'status', FOLLOWUP_STATUS) : f.status;
    const outcome = body.outcome !== undefined ? text(body.outcome, 'outcome', 500) : f.outcome;
    const due = body.dueDate !== undefined ? date(body.dueDate, 'due date') : f.dueDate;
    const title = body.title !== undefined ? text(body.title, 'What needs to happen', 200, { required: true }) : f.title;
    const now = iso(env.now());
    await env.sql`UPDATE followups SET status = ${status}, outcome = ${outcome}, due_date = ${due}, title = ${title}, updated_at = ${now}, completed_at = CASE WHEN ${status} = 'done' AND completed_at IS NULL THEN ${now}::timestamptz ELSE completed_at END WHERE id = ${f.id}`;
    await env.audit('followup.updated', f.id, { status });
    return json({ followup: (await listFollowups(env)).find(x => x.id === f.id) });
  }
  return notFound();
}

// ---------- Outreach log ----------
const toOutreach = r => { const o = row(r); return { id: o.id, date: o.date, channel: o.channel, place: o.place, approached: o.approached, demos: o.demos, reportedSignups: o.reported_signups, followUpCommitments: o.follow_up_commitments, observations: o.observations, blockers: o.blockers, evidence: o.evidence, recordedBy: o.recorded_by, createdAt: o.created_at }; };
async function outreach(parts, method, body, env) {
  env.need('outreach.record');
  if (method === 'GET' && !parts.length) {
    const r = await env.sql`SELECT id, date::text AS date, channel, place, approached, demos, reported_signups, follow_up_commitments, observations, blockers, evidence, recorded_by, created_at FROM outreach WHERE org_id = ${env.orgId} ORDER BY date DESC, created_at DESC LIMIT 500`;
    return json({ outreach: r.map(toOutreach), refs: REFS });
  }
  if (method === 'POST' && !parts.length) {
    const now = iso(env.now()), id = newId('o');
    await env.sql`INSERT INTO outreach (id, org_id, date, channel, place, approached, demos, reported_signups, follow_up_commitments, observations, blockers, recorded_by, created_at)
      VALUES (${id}, ${env.orgId}, ${date(body.date, 'date') || now.slice(0, 10)}, ${oneOf(body.channel, 'channel', REFS)}, ${text(body.place, 'Organization or event', 120, { required: true })},
      ${count(body.approached, 'People approached')}, ${count(body.demos, 'Demos')}, ${count(body.reportedSignups, 'Sign-ups reported')},
      ${text(body.followUpCommitments, 'Follow-up commitments', 500)}, ${text(body.observations, 'Observations', 1000)}, ${text(body.blockers, 'Blockers', 500)}, ${env.member.id}, ${now})`;
    await env.audit('outreach.recorded', id);
    const r = await env.sql`SELECT id, date::text AS date, channel, place, approached, demos, reported_signups, follow_up_commitments, observations, blockers, evidence, recorded_by, created_at FROM outreach WHERE id = ${id}`;
    return json({ outreach: toOutreach(r[0]) }, 201);
  }
  return notFound();
}

// ---------- Institutional relationships ----------
export async function getRelationships(env, id = null) {
  const r = await env.sql`SELECT id, version, created_by, contact_name, organization, office, stage, next_action, next_action_date::text AS next_action_date, owner, notes, offer_approved, agreement_status, created_at, updated_at
    FROM relationships WHERE org_id = ${env.orgId} AND (${id}::text IS NULL OR id = ${id}) ORDER BY next_action_date NULLS LAST, created_at LIMIT 500`;
  const logs = (rows(await env.sql`SELECT relationship_id, at, by_member, kind, summary FROM relationship_log WHERE org_id = ${env.orgId} AND (${id}::text IS NULL OR relationship_id = ${id}) ORDER BY id DESC LIMIT 2000`)).reverse();
  return r.map(x => { const o = row(x); return { id: o.id, version: o.version, createdBy: o.created_by, contactName: o.contact_name, organization: o.organization, office: o.office, stage: o.stage, nextAction: o.next_action, nextActionDate: o.next_action_date, owner: o.owner, notes: o.notes, offerApproved: o.offer_approved, agreementStatus: o.agreement_status, createdAt: o.created_at, updatedAt: o.updated_at, log: logs.filter(l => l.relationship_id === o.id).map(l => ({ at: l.at, by: l.by_member, kind: l.kind, summary: l.summary })) }; });
}
async function relationships(parts, method, body, env) {
  env.need('relationships.record');
  if (method === 'GET' && !parts.length) return json({ relationships: await getRelationships(env), stages: STAGES });
  if (method === 'POST' && !parts.length) {
    const now = iso(env.now()), id = newId('r');
    await env.sql`INSERT INTO relationships (id, org_id, contact_name, organization, office, stage, next_action, next_action_date, owner, notes, created_by, created_at, updated_at)
      VALUES (${id}, ${env.orgId}, ${text(body.contactName, 'Contact name', 80, { required: true })}, ${text(body.organization, 'Organization', 120, { required: true })}, ${text(body.office, 'Office or function', 120)},
      ${oneOf(body.stage, 'stage', STAGES, 'identified')}, ${text(body.nextAction, 'Next action', 200)}, ${date(body.nextActionDate, 'next action date')}, ${env.member.id}, ${text(body.notes, 'notes', 1000)}, ${env.member.id}, ${now}, ${now})`;
    await env.audit('relationship.created', id);
    return json({ relationship: (await getRelationships(env, id))[0] }, 201);
  }
  if (parts[0]) {
    const r = (await getRelationships(env, parts[0]))[0]; if (!r) return notFound();
    if (method === 'PATCH') {
      // Offer approval is its own founder-only change, so it can't be undone by someone saving notes (IR-05).
      if (body.offerApproved !== undefined) {
        env.need('relationships.approveOffer');
        await env.sql`UPDATE relationships SET offer_approved = ${!!body.offerApproved}, updated_at = ${iso(env.now())}, version = version + 1 WHERE id = ${r.id}`;
        await env.audit('relationship.offer_' + (body.offerApproved ? 'approved' : 'withdrawn'), r.id);
        return json({ relationship: (await getRelationships(env, r.id))[0] });
      }
      // Coordinators edit the relationships they own or added; the founder edits any.
      if (env.member.role !== 'founder' && r.owner !== env.member.id && r.createdBy !== env.member.id) return json({ error: { code: 'forbidden', message: 'Ask Dion to update this relationship, or log a contact instead.' } }, 403);
      if (!Number.isInteger(body.version)) throw new Invalid('Missing version: reload and try again');
      const v = {
        nextAction: body.nextAction !== undefined ? text(body.nextAction, 'Next action', 200) : r.nextAction,
        notes: body.notes !== undefined ? text(body.notes, 'notes', 1000) : r.notes,
        office: body.office !== undefined ? text(body.office, 'Office', 120) : r.office,
        nextActionDate: body.nextActionDate !== undefined ? date(body.nextActionDate, 'next action date') : r.nextActionDate,
        stage: body.stage !== undefined ? oneOf(body.stage, 'stage', STAGES) : r.stage,
      };
      const done = await env.sql`UPDATE relationships SET next_action = ${v.nextAction}, notes = ${v.notes}, office = ${v.office}, next_action_date = ${v.nextActionDate}, stage = ${v.stage}, updated_at = ${iso(env.now())}, version = version + 1
        WHERE id = ${r.id} AND version = ${body.version} RETURNING id`;
      if (!done[0]) throw new Conflict();
      await env.audit('relationship.updated', r.id);
      return json({ relationship: (await getRelationships(env, r.id))[0] });
    }
    if (method === 'POST' && parts[1] === 'log') {
      const kind = oneOf(body.kind, 'kind', ['meeting', 'demo', 'call', 'email', 'note']);
      await env.sql`INSERT INTO relationship_log (org_id, relationship_id, at, by_member, kind, summary) VALUES (${env.orgId}, ${r.id}, ${iso(env.now())}, ${env.member.id}, ${kind}, ${text(body.summary, 'summary', 500, { required: true })})`;
      await env.sql`UPDATE relationships SET updated_at = ${iso(env.now())} WHERE id = ${r.id}`;
      await env.audit('relationship.logged', r.id, { kind });
      return json({ relationship: (await getRelationships(env, r.id))[0] }, 201);
    }
  }
  return notFound();
}

// ---------- Dashboard: evidence-backed actuals, never a silent zero (IR-03, R2-03) ----------
// People count only when they are reviewed (not a test), have not withdrawn, and the metric's own
// evidence exists: a registration needs an intake ledger row, a beta tester an active beta program
// membership, and account/activation/repeat need a founder-verified state. Reported states are shown
// next to them, labelled as reported. Households are counted separately from people.
export const ACTIVE_ENGAGEMENT = ['first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed'];
async function dashboard(env) {
  env.need('dashboard.view');
  const scopeAll = env.has('participants.view.all');
  const people = rows(await env.sql`SELECT p.id, p.first_name, p.created_at, p.is_test, p.withdrawn_at, p.household_key, p.account, p.account_verified, p.engagement, p.engagement_verified, p.communication, p.technical_source, p.reported_source, p.origin,
      EXISTS (SELECT 1 FROM pilot_intake_records r WHERE r.participant_id = p.id AND r.cohort = 'pilot') AS pilot_evidence,
      EXISTS (SELECT 1 FROM cohort_memberships c WHERE c.participant_id = p.id AND c.cohort = 'beta' AND c.status = 'active') AS beta_member,
      EXISTS (SELECT 1 FROM cohort_memberships c WHERE c.participant_id = p.id AND c.cohort = 'pilot' AND c.status = 'active' AND c.evidence_kind = 'founder_record') AS pilot_by_record
    FROM participants p WHERE p.org_id = ${env.orgId} AND (${scopeAll} OR p.assigned_to = ${env.member.id}) ORDER BY p.created_at DESC LIMIT 5001`);
  const truncated = people.length > 5000;
  const all = people.slice(0, 5000);
  const counted = all.filter(p => p.is_test === false && !p.withdrawn_at);
  const households = list => new Set(list.map(p => p.household_key ? `h:${p.household_key}` : `p:${p.id}`)).size;
  const fus = await listFollowups(env, { openOnly: true });
  const rels = await getRelationships(env);
  const outs = (await env.sql`SELECT count(*)::int AS n FROM outreach WHERE org_id = ${env.orgId}`)[0].n;
  const pendingApprovals = env.has('approvals.view.all')
    ? (await env.sql`SELECT count(*)::int AS n FROM approvals WHERE org_id = ${env.orgId} AND status = 'pending'`)[0].n
    : (await env.sql`SELECT count(*)::int AS n FROM approvals WHERE org_id = ${env.orgId} AND status = 'changes_requested' AND submitted_by = ${env.member.id}`)[0].n;
  const surveyStats = (await env.sql`SELECT (SELECT count(*)::int FROM survey_invites WHERE org_id = ${env.orgId} AND revoked_at IS NULL) AS invited, (SELECT count(*)::int FROM survey_responses WHERE org_id = ${env.orgId}) AS responded`)[0];
  const openConflicts = scopeAll ? (await env.sql`SELECT count(*)::int AS n FROM intake_conflicts WHERE org_id = ${env.orgId} AND status = 'open'`)[0].n : 0;
  const today = iso(env.now()).slice(0, 10);
  const in14 = iso(env.now() + 14 * 864e5).slice(0, 10);
  const backfill = (await env.sql`SELECT value FROM org_meta WHERE org_id = ${env.orgId} AND key = 'backfill'`)[0]?.value || null;
  const coverage = backfill && !truncated ? 'actual' : 'incomplete';

  const countBy = (list, f) => list.reduce((o, x) => { const k = x[f] ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const metric = (id, label, value, status, definition, source, extra = {}) => ({ id, label, value, status, definition, source, ...extra });
  const regs = counted.filter(p => p.pilot_evidence);
  const regUnreviewed = all.filter(p => p.pilot_evidence && p.is_test === null && !p.withdrawn_at).length;
  const regWithdrawn = all.filter(p => p.pilot_evidence && p.withdrawn_at).length;
  const byRecordOnly = counted.filter(p => p.pilot_by_record && !p.pilot_evidence).length;
  const verified = (f, values) => counted.filter(p => p[`${f}_verified`] && values.includes(p[f]));
  const reported = (f, values) => counted.filter(p => !p[`${f}_verified`] && values.includes(p[f])).length;
  const anyVerified = f => counted.some(p => p[`${f}_verified`]);
  const notes = [
    regUnreviewed && `${regUnreviewed} waiting for review`, regWithdrawn && `${regWithdrawn} withdrew`,
    byRecordOnly && `${byRecordOnly} added to the pilot by founder record without a form registration (not counted)`,
    openConflicts && `${openConflicts} held for conflict review`,
    !backfill && 'registrations from before this workspace have not been reconciled yet, so this is not the full count',
  ].filter(Boolean);
  const regNote = `Registrations backed by a form submission or a reconciled import, reviewed and not tests.${notes.length ? ' ' + notes.join('; ') + '.' : ''}`;
  const verifiedMetric = (id, label, f, values, def) => {
    const v = anyVerified(f) ? verified(f, values) : null;
    return metric(id, label, v ? v.length : null, v ? coverage : 'unknown', `${def} ${reported(f, values)} more reported by the team but not yet checked.`, 'Founder verification', v ? { households: households(v) } : {});
  };

  return json({
    scope: scopeAll ? 'all' : 'assigned',
    generatedAt: iso(env.now()),
    backfillComplete: !!backfill,
    coverage,
    metrics: [
      metric('registrations', 'Verified pilot registrations', regs.length, coverage, regNote, 'Intake ledger', { households: households(regs) }),
      metric('target', 'Recruitment target', '10–20 families', 'target', 'Goal set in the Nov 21, 2026 launch record. A target, not a result.', 'Launch record'),
      metric('beta', 'Existing beta testers', counted.filter(p => p.beta_member).length, coverage, 'Reviewed people with an active beta program membership from an app account import. Beta accounts are not automatically pilot participants.', 'Program memberships'),
      verifiedMetric('accounts', 'App accounts confirmed (verified)', 'account', ['confirmed'], 'Confirmed accounts the founder checked against the app.'),
      verifiedMetric('activation', 'Activated (verified)', 'engagement', ACTIVE_ENGAGEMENT, 'Generated a first plan or more, checked by the founder. An account, a survey or finishing the pilot alone is not activation.'),
      verifiedMetric('repeat', 'Repeat use (verified)', 'engagement', ['repeat_use_observed'], 'Only "repeat use observed" counts.'),
      metric('surveys', 'Survey responses', surveyStats.invited ? `${surveyStats.responded} of ${surveyStats.invited}` : null, surveyStats.invited ? 'actual' : 'pending', surveyStats.invited ? 'Responses received out of survey links created (cancelled links not counted).' : 'No survey links sent yet.', 'Research & testing'),
      metric('followups', 'Open follow-ups', fus.length, 'actual', `${fus.filter(f => f.dueDate && f.dueDate < today).length} overdue.`, 'Follow-up queue'),
      metric('approvals', scopeAll ? 'Waiting for your approval' : 'Sent back to you for changes', pendingApprovals, 'actual', scopeAll ? 'Items the team submitted for review.' : 'Items Dion asked you to change.', 'Approvals'),
      metric('relationships', 'Institutional relationships', rels.length, 'actual', 'Relationship-cultivation records. None of these is an approved partnership or agreement.', 'Relationships'),
      metric('outreach', 'Outreach sessions logged', outs, 'field_report', 'Self-reported by the team.', 'Outreach log'),
    ],
    // Breakdowns are of reviewed, non-withdrawn people. Sources and states here are as reported unless a metric above says verified.
    breakdowns: {
      technicalSource: countBy(regs, 'technical_source'), reportedSource: countBy(counted, 'reported_source'),
      account: countBy(counted, 'account'), engagement: countBy(counted, 'engagement'), communication: countBy(counted, 'communication'),
      relationshipStage: countBy(rels, 'stage'),
    },
    breakdownBasis: 'reported',
    upcoming: rels.filter(r => r.nextActionDate && r.nextActionDate >= today && r.nextActionDate <= in14).map(r => ({ id: r.id, contactName: r.contactName, organization: r.organization, nextAction: r.nextAction, nextActionDate: r.nextActionDate })),
    dueFollowups: fus.filter(f => !f.dueDate || f.dueDate <= in14).slice(0, 10),
    recentRegistrations: all.filter(p => p.pilot_evidence).slice(0, 5).map(p => ({ id: p.id, firstName: p.first_name, createdAt: p.created_at, technicalSource: p.technical_source })),
  });
}
