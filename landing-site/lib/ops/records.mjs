// Recruitment operations: participants, pilot-form intake, follow-ups, outreach log, relationships, dashboard.
import { normalizeEmail, sha256 } from './security.mjs';
import { parsePilot } from '../pilot-welcome.mjs';
import { json, notFound, Invalid, newId, iso, text, oneOf, date, count, maskEmail, row, rows, asJson } from './util.mjs';
import { memberById } from './core.mjs';

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
    verified: { account: p.account_verified, engagement: p.engagement_verified, communication: p.communication_verified }, version: p.version, assignedTo: p.assigned_to, isTest: p.is_test, origin: p.origin, intake: p.intake, notes: p.notes, createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at };
};
export function viewParticipant(p, env) {
  const showContact = env.has('participants.contact.all') || p.assignedTo === env.member.id;
  return { ...p, email: showContact ? p.email : maskEmail(p.email), emailMasked: !showContact && !!p.email };
}
export async function visibleParticipants(env) {
  const all = env.has('participants.view.all')
    ? await env.sql`SELECT * FROM participants WHERE org_id = ${env.orgId} ORDER BY created_at DESC`
    : await env.sql`SELECT * FROM participants WHERE org_id = ${env.orgId} AND assigned_to = ${env.member.id} ORDER BY created_at DESC`;
  return all.map(toParticipant);
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
    return json({ participants: (await visibleParticipants(env)).map(p => viewParticipant(p, env)), states: STATES, refs: REFS, scope: env.has('participants.view.all') ? 'all' : 'assigned' });
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
    await env.sql`INSERT INTO participants (id, org_id, first_name, email, cohort, enrollment, account, engagement, communication, technical_source, reported_source, assigned_to, is_test, origin, intake, notes, created_by, created_at, updated_at)
      VALUES (${id}, ${env.orgId}, ${p.firstName}, ${email}, ${p.cohort}, ${p.enrollment}, ${p.account}, ${p.engagement}, ${p.communication}, NULL, ${p.reportedSource}, ${assignedTo}, false, 'manual', NULL, ${p.notes}, ${me.id}, ${now}, ${now})`;
    await history(env, id, me.id, [{ field: 'created', to: p.enrollment }]);
    await env.audit('participant.created', id);
    return json({ participant: viewParticipant(await getParticipant(env, id), env) }, 201);
  }
  if (method === 'POST' && parts[0] === 'import') return importParticipants(body, env);
  if (parts[0]) {
    const p = await getParticipant(env, parts[0]);
    if (!p) return notFound();
    if (method === 'GET') {
      const h = rows(await env.sql`SELECT at, actor, changes FROM participant_history WHERE participant_id = ${p.id} ORDER BY id`);
      return json({ participant: viewParticipant(p, env), history: h });
    }
    if (method === 'PATCH') {
      env.need('participants.update.assigned');
      if (body.technicalSource !== undefined || body.email !== undefined || body.heardFrom !== undefined) throw new Invalid('Email and form sources can only be changed by the founder through a data correction');
      if (!Number.isInteger(body.version)) throw new Invalid('Missing version: reload and try again');
      const isFounderVerify = env.has('participants.verify');
      const changes = [], next = { ...p, verified: { ...p.verified } };
      const setField = (f, v) => { if (v !== undefined && v !== p[f]) { changes.push({ field: f, from: p[f], to: v }); next[f] = v; } };
      if (body.cohort !== undefined) { env.need('participants.verify'); setField('cohort', oneOf(body.cohort, 'cohort', STATES.cohort)); }
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
      if (body.enrollment !== undefined) setField('enrollment', oneOf(body.enrollment, 'enrollment', STATES.enrollment));
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
      const all = env.has('participants.view.all');
      const updated = await env.sql`UPDATE participants SET first_name = ${next.firstName}, cohort = ${next.cohort}, enrollment = ${next.enrollment}, account = ${next.account}, engagement = ${next.engagement}, communication = ${next.communication},
        account_verified = ${next.verified.account}, engagement_verified = ${next.verified.engagement}, communication_verified = ${next.verified.communication},
        reported_source = ${next.reportedSource}, assigned_to = ${next.assignedTo}, is_test = ${next.isTest}, notes = ${next.notes}, updated_at = ${iso(env.now())}, version = version + 1
        WHERE id = ${p.id} AND org_id = ${env.orgId} AND version = ${body.version} AND (${all} OR assigned_to = ${me.id}) RETURNING id`;
      if (!updated[0]) throw new Conflict();
      const nameOf = async id => id ? ((await memberById(env, id))?.name || 'former member') : 'nobody';
      const logged = [];
      for (const c of changes) {
        if (c.field === 'notes') logged.push({ field: 'notes', to: '(edited)' });
        else if (c.field === 'assignedTo') logged.push({ field: 'assigned to', from: await nameOf(c.from), to: await nameOf(c.to) });
        else logged.push(c);
      }
      await history(env, p.id, me.id, logged);
      await env.audit('participant.updated', p.id, { fields: changes.map(c => c.field) });
      return json({ participant: viewParticipant(await getParticipant(env, p.id), env) });
    }
  }
  return notFound();
}

// Pilot form intake (IR-04). Uses the same strict check as the welcome email, records every distinct
// delivery with provenance in an append-only ledger, and is safe to run twice for the same event.
const CONSENT = { purpose: 'pilot_email', value: 'yes', version: null }; // the form's consent text has no version number yet
export async function ingestPilotSubmission({ sql, orgId }, data, nowIso, meta = {}) {
  const parsed = parsePilot(data);
  if (!parsed) return 'skipped_invalid';
  const { email, firstName } = parsed;
  const source = data.source;
  const heardFrom = typeof data.heard_from === 'string' ? data.heard_from.trim().slice(0, 80) || null : null;
  const children = data.children_under_10;
  const submissionId = typeof meta.submissionId === 'string' && /^[\w-]{1,64}$/.test(meta.submissionId) ? meta.submissionId : null;
  const sourceTs = typeof meta.submittedAt === 'string' && !Number.isNaN(Date.parse(meta.submittedAt)) ? new Date(meta.submittedAt).toISOString() : null;
  const payloadHash = sha256(JSON.stringify([email, firstName, source, heardFrom, children, submissionId]));
  const intake = { form: 'pilot', receivedAt: nowIso, submissionId, childrenUnder10: children };

  // Duplicate delivery of the same event: nothing new to record.
  if ((await sql`SELECT 1 FROM pilot_intake_records WHERE org_id = ${orgId} AND payload_hash = ${payloadHash}`)[0]) return 'duplicate_event';

  const id = newId('p');
  let outcome = 'created', participantId = id;
  const inserted = await sql`INSERT INTO participants (id, org_id, first_name, email, cohort, enrollment, account, engagement, communication, technical_source, heard_from, reported_source, assigned_to, is_test, origin, intake, notes, created_by, created_at, updated_at)
    VALUES (${id}, ${orgId}, ${firstName}, ${email}, 'pilot', 'registration_received', 'unknown', 'unknown', 'unknown', ${source}, ${heardFrom}, 'unknown', NULL, NULL, 'pilot-form', ${asJson(intake)}::jsonb, '', 'pilot-form', ${nowIso}, ${nowIso})
    ON CONFLICT (org_id, email) WHERE email <> '' DO NOTHING RETURNING id`;
  if (!inserted[0]) {
    const existing = (await sql`SELECT id, cohort, enrollment, technical_source FROM participants WHERE org_id = ${orgId} AND email = ${email}`)[0];
    participantId = existing.id;
    if (existing.cohort === 'prospect' || !existing.technical_source) {
      // Someone the team added by hand has now registered through the form: promote and record the form source.
      await sql`UPDATE participants SET cohort = CASE WHEN cohort = 'prospect' THEN 'pilot' ELSE cohort END,
        enrollment = CASE WHEN enrollment = 'prospect' THEN 'registration_received' ELSE enrollment END,
        technical_source = coalesce(technical_source, ${source}), heard_from = coalesce(heard_from, ${heardFrom}),
        intake = coalesce(intake, ${asJson(intake)}::jsonb), updated_at = ${nowIso}, version = version + 1 WHERE id = ${existing.id}`;
      outcome = 'promoted_prospect';
    } else outcome = 'linked_existing';
  }
  const ledger = await sql`INSERT INTO pilot_intake_records (id, org_id, source_submission_id, payload_hash, source_timestamp, received_at, provenance, consent, technical_source, heard_from, participant_id, outcome)
    VALUES (${newId('in')}, ${orgId}, ${submissionId}, ${payloadHash}, ${sourceTs}, ${nowIso}, ${submissionId ? 'event_with_id' : 'event_without_id'}, ${asJson(CONSENT)}::jsonb, ${source}, ${heardFrom}, ${participantId}, ${outcome})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!ledger[0]) return 'duplicate_event';
  await sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${orgId}, ${participantId}, ${nowIso}, 'pilot-form', ${asJson([{ field: 'intake', to: `${outcome} (link source: ${source})` }])}::jsonb)`;
  return outcome;
}

// IR-09: founder-only backfill of records that came in before this workspace (form exports, beta testers).
// Data arrives through this authorized request, never from the code; every row keeps where it came from.
async function importParticipants(body, env) {
  env.need('participants.verify');
  const source = oneOf(body.source, 'source', ['netlify_forms_export', 'app_identity_export', 'founder_records']);
  const exportedAt = date(body.exportedAt, 'export date');
  if (!exportedAt) throw new Invalid('Say when the export was made');
  if (!Array.isArray(body.records) || !body.records.length || body.records.length > 200) throw new Invalid('Send between 1 and 200 records');
  const results = [];
  for (const [i, r] of body.records.entries()) {
    const email = normalizeEmail(r?.email);
    const firstName = text(r?.firstName, `Row ${i + 1} first name`, 60, { required: true });
    if (!email) throw new Invalid(`Row ${i + 1}: email is not valid`);
    const cohort = oneOf(r.cohort, `Row ${i + 1} cohort`, ['pilot', 'beta'], source === 'app_identity_export' ? 'beta' : 'pilot');
    const submittedAt = r.submittedAt && !Number.isNaN(Date.parse(r.submittedAt)) ? new Date(r.submittedAt).toISOString() : null;
    const techSource = typeof r.source === 'string' && /^[\w-]{1,40}$/.test(r.source) ? r.source : null;
    const now = iso(env.now()), id = newId('p');
    const intake = { form: source === 'netlify_forms_export' ? 'pilot' : null, importedFrom: source, exportedAt, submittedAt, importedBy: env.member.id };
    const ins = await env.sql`INSERT INTO participants (id, org_id, first_name, email, cohort, enrollment, account, engagement, communication, technical_source, reported_source, assigned_to, is_test, origin, intake, notes, created_by, created_at, updated_at)
      VALUES (${id}, ${env.orgId}, ${firstName}, ${email}, ${cohort}, ${cohort === 'pilot' ? 'registration_received' : 'enrolled'}, ${cohort === 'beta' ? 'created' : 'unknown'}, 'unknown', 'unknown', ${techSource}, 'unknown', NULL, NULL, ${'import:' + source}, ${asJson(intake)}::jsonb, '', ${env.member.id}, ${submittedAt || now}, ${now})
      ON CONFLICT (org_id, email) WHERE email <> '' DO NOTHING RETURNING id`;
    if (ins[0]) { await history(env, id, env.member.id, [{ field: 'imported', to: `${cohort} from ${source} (exported ${exportedAt})` }]); results.push('created'); }
    else results.push('already_exists');
  }
  await env.audit('participants.imported', null, { source, count: body.records.length });
  if (body.markBackfillComplete === true) await env.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${env.orgId}, 'backfill', ${asJson({ completeAt: iso(env.now()), by: env.member.id, source })}::jsonb) ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`;
  return json({ created: results.filter(r => r === 'created').length, alreadyExisted: results.filter(r => r === 'already_exists').length }, 201);
}

// ---------- Follow-ups ----------
const toFollowup = r => { const f = row(r); return { id: f.id, title: f.title, subjectType: f.subject_type, subjectId: f.subject_id, dueDate: f.due_date, assignedTo: f.assigned_to, status: f.status, outcome: f.outcome, createdAt: f.created_at, updatedAt: f.updated_at, completedAt: f.completed_at }; };
const FU_SELECT = 'id, title, subject_type, subject_id, due_date::text AS due_date, assigned_to, status, outcome, created_at, updated_at, completed_at';
void FU_SELECT;
export async function listFollowups(env, { openOnly = false } = {}) {
  const all = env.has('followups.view.all');
  const r = await env.sql`SELECT id, title, subject_type, subject_id, due_date::text AS due_date, assigned_to, status, outcome, created_at, updated_at, completed_at FROM followups
    WHERE org_id = ${env.orgId} AND (${all} OR assigned_to = ${env.member.id}) AND (${!openOnly} OR status = 'open') ORDER BY due_date NULLS LAST, created_at`;
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
    const r = await env.sql`SELECT id, date::text AS date, channel, place, approached, demos, reported_signups, follow_up_commitments, observations, blockers, evidence, recorded_by, created_at FROM outreach WHERE org_id = ${env.orgId} ORDER BY date DESC, created_at DESC`;
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
    FROM relationships WHERE org_id = ${env.orgId} AND (${id}::text IS NULL OR id = ${id}) ORDER BY next_action_date NULLS LAST, created_at`;
  const logs = rows(await env.sql`SELECT relationship_id, at, by_member, kind, summary FROM relationship_log WHERE org_id = ${env.orgId} AND (${id}::text IS NULL OR relationship_id = ${id}) ORDER BY id`);
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

// ---------- Dashboard: actuals vs targets vs unknown, never a silent zero ----------
async function dashboard(env) {
  env.need('dashboard.view');
  const scopeAll = env.has('participants.view.all');
  const ps = (await visibleParticipants(env)).filter(p => p.isTest !== true);
  const fus = await listFollowups(env, { openOnly: true });
  const rels = await getRelationships(env);
  const outs = (await env.sql`SELECT count(*)::int AS n FROM outreach WHERE org_id = ${env.orgId}`)[0].n;
  const pendingApprovals = env.has('approvals.view.all')
    ? (await env.sql`SELECT count(*)::int AS n FROM approvals WHERE org_id = ${env.orgId} AND status = 'pending'`)[0].n
    : (await env.sql`SELECT count(*)::int AS n FROM approvals WHERE org_id = ${env.orgId} AND status = 'changes_requested' AND submitted_by = ${env.member.id}`)[0].n;
  const surveyStats = (await env.sql`SELECT (SELECT count(*)::int FROM survey_invites WHERE org_id = ${env.orgId}) AS invited, (SELECT count(*)::int FROM survey_responses WHERE org_id = ${env.orgId}) AS responded`)[0];
  const today = iso(env.now()).slice(0, 10);
  const in14 = iso(env.now() + 14 * 864e5).slice(0, 10);

  const countBy = (list, f) => list.reduce((o, x) => { const k = x[f] ?? 'unknown'; o[k] = (o[k] || 0) + 1; return o; }, {});
  const metric = (id, label, value, status, definition, source) => ({ id, label, value, status, definition, source });
  const backfill = (await env.sql`SELECT value FROM org_meta WHERE org_id = ${env.orgId} AND key = 'backfill'`)[0]?.value || null;
  const pilots = ps.filter(p => p.cohort === 'pilot');
  const formRegs = pilots.filter(p => p.origin === 'pilot-form' || p.origin === 'import:netlify_forms_export');
  const verifiedRegs = formRegs.filter(p => p.isTest === false);
  const unreviewed = formRegs.filter(p => p.isTest === null).length;
  const handAdded = pilots.filter(p => p.origin === 'manual').length;
  // IR-03: only founder-verified states count as actual. Reported (unverified) states are shown separately.
  const verifiedState = (f, values) => ps.filter(p => p.verified[f] && values.includes(p[f])).length;
  const reportedState = (f, values) => ps.filter(p => !p.verified[f] && values.includes(p[f])).length;
  const anyVerified = f => ps.some(p => p.verified[f]);
  const ACTIVE = ['first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed', 'pilot_completed'];
  const regNote = `Form registrations reviewed and confirmed not to be tests.${unreviewed ? ` ${unreviewed} more waiting for review.` : ''}${handAdded ? ` ${handAdded} added by hand are not counted.` : ''}${backfill ? '' : ' Registrations from before this workspace have not been imported yet, so this is not the full count.'}`;

  return json({
    scope: scopeAll ? 'all' : 'assigned',
    generatedAt: iso(env.now()),
    backfillComplete: !!backfill,
    metrics: [
      metric('registrations', 'Verified pilot registrations', verifiedRegs.length, backfill ? 'actual' : 'incomplete', regNote, 'Pilot form intake and founder imports'),
      metric('target', 'Recruitment target', '10–20 families', 'target', 'Goal set in the Nov 21, 2026 launch record. A target, not a result.', 'Launch record'),
      metric('beta', 'Existing beta testers', ps.filter(p => p.cohort === 'beta').length, backfill ? 'actual' : 'incomplete', 'Beta-cohort participants. Beta accounts are not automatically pilot participants.', 'Founder imports'),
      metric('accounts', 'App accounts confirmed (verified)', anyVerified('account') ? verifiedState('account', ['confirmed']) : null, anyVerified('account') ? 'actual' : 'unknown', `Confirmed accounts the founder checked against the app. ${reportedState('account', ['confirmed'])} more reported by the team but not yet checked.`, 'Founder verification'),
      metric('activation', 'Activated (verified)', anyVerified('engagement') ? verifiedState('engagement', ACTIVE) : null, anyVerified('engagement') ? 'actual' : 'unknown', `Generated a first plan or more, checked by the founder. ${reportedState('engagement', ACTIVE)} more reported but not checked. An account alone is not activation.`, 'Founder verification'),
      metric('repeat', 'Repeat use (verified)', anyVerified('engagement') ? verifiedState('engagement', ['repeat_use_observed']) : null, anyVerified('engagement') ? 'actual' : 'unknown', 'Only "repeat use observed" counts. Submitting a survey or finishing the pilot is not evidence of coming back.', 'Founder verification'),
      metric('surveys', 'Survey responses', surveyStats.invited ? `${surveyStats.responded} of ${surveyStats.invited}` : null, surveyStats.invited ? 'actual' : 'pending', surveyStats.invited ? 'Responses received out of survey links created.' : 'No survey links sent yet.', 'Research & testing'),
      metric('followups', 'Open follow-ups', fus.length, 'actual', `${fus.filter(f => f.dueDate && f.dueDate < today).length} overdue.`, 'Follow-up queue'),
      metric('approvals', scopeAll ? 'Waiting for your approval' : 'Sent back to you for changes', pendingApprovals, 'actual', scopeAll ? 'Items the team submitted for review.' : 'Items Dion asked you to change.', 'Approvals'),
      metric('relationships', 'Institutional relationships', rels.length, 'actual', 'Relationship-cultivation records. None of these is an approved partnership or agreement.', 'Relationships'),
      metric('outreach', 'Outreach sessions logged', outs, 'field_report', 'Self-reported by the team.', 'Outreach log'),
    ],
    breakdowns: {
      technicalSource: countBy(formRegs, 'technicalSource'), reportedSource: countBy(ps, 'reportedSource'),
      account: countBy(ps, 'account'), engagement: countBy(ps, 'engagement'), communication: countBy(ps, 'communication'),
      relationshipStage: countBy(rels, 'stage'),
    },
    upcoming: rels.filter(r => r.nextActionDate && r.nextActionDate >= today && r.nextActionDate <= in14).map(r => ({ id: r.id, contactName: r.contactName, organization: r.organization, nextAction: r.nextAction, nextActionDate: r.nextActionDate })),
    dueFollowups: fus.filter(f => !f.dueDate || f.dueDate <= in14).slice(0, 10),
    recentRegistrations: formRegs.slice(0, 5).map(p => ({ id: p.id, firstName: p.firstName, createdAt: p.createdAt, technicalSource: p.technicalSource })),
  });
}
