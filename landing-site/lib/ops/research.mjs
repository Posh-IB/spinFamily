// Research & testing: cohorts (e.g. Marilyn's parent-testing program), sessions, a versioned questionnaire
// that needs founder approval before use, one-time survey links, and response summaries.
import { sha256, newToken } from './security.mjs';
import { json, fail, notFound, Invalid, newId, iso, text, oneOf, date, count, row, rows, asJson } from './util.mjs';
import { getParticipant } from './records.mjs';
import { submitForApproval, supersedePending } from './approvals.mjs';
import { inTx, barrier } from './db.mjs';

const COHORT_STATUS = ['planned', 'active', 'completed', 'cancelled'];
// Consent is never an enrollment status anyone can set: it is a research_consents record, given by
// the parent on the survey page or recorded by the founder from written consent (R2-05).
const ENROLL_STATUS = ['invited', 'completed', 'withdrawn'];
export const SMALL_CELL = 5;

// The participation notice parents see before answering. A new version needs founder approval again.
export const RESEARCH_NOTICE = {
  version: 'SF-RN-2026-11-v1',
  text: [
    'SpinFamily is asking pilot families a few questions to learn whether the app helps. Taking part is up to you.',
    'Every question is optional. Please don\'t include your children\'s names or other details about them.',
    'Your answers go to the SpinFamily founder. Other team members only ever see totals from 5 or more families, never your individual answers.',
    'Your answers are used only to improve SpinFamily during the pilot. They are not sold or shared for advertising.',
    'You can stop at any time. Use "Withdraw from research" on this page, or reply to any SpinFamily email, and we will stop asking and remove your answers on request.',
  ],
};
async function noticeState(env) {
  const v = (await env.sql`SELECT value FROM org_meta WHERE org_id = ${env.orgId} AND key = 'research_notice'`)[0]?.value || null;
  return { current: RESEARCH_NOTICE, approved: v, approvedCurrent: !!v && v.version === RESEARCH_NOTICE.version };
}
const SESSION_KINDS = ['initial', 'follow_up', 'interview'];
const QTYPES = ['scale', 'choice', 'yesno', 'text'];
export const SURVEY_LINK_TTL_MS = 30 * 864e5;

// Draft from SF-PILOT-OPS-001 §15. Neutral wording, everything optional, nothing about children's identities.
export const DRAFT_QUESTIONNAIRE = {
  title: 'SpinFamily parent questionnaire',
  intro: 'Thanks for trying SpinFamily. This takes about 3–5 minutes. Every question is optional. Please don\'t include your children\'s names or other details about them.',
  questions: [
    { id: 'q1', section: 'Before SpinFamily', type: 'choice', text: 'How often is it hard to decide what to do together as a family?', options: ['Almost never', 'Sometimes', 'Often', 'Almost always'] },
    { id: 'q2', section: 'Before SpinFamily', type: 'choice', text: 'About how long does it usually take to decide on a family activity?', options: ['Under 5 minutes', '5–15 minutes', '15–30 minutes', 'More than 30 minutes', 'We often don\'t decide'] },
    { id: 'q3', section: 'Before SpinFamily', type: 'text', text: 'What do you use now to decide or plan family activities (apps, calendars, lists, nothing in particular)?' },
    { id: 'q4', section: 'Using SpinFamily', type: 'scale', text: 'How easy was SpinFamily to use?', min: 1, max: 5, minLabel: 'Very hard', maxLabel: 'Very easy' },
    { id: 'q5', section: 'Using SpinFamily', type: 'scale', text: 'How well did the suggested activities fit your family?', min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very well' },
    { id: 'q6', section: 'Using SpinFamily', type: 'choice', text: 'Compared with usual, did SpinFamily change how quickly you decided?', options: ['Faster', 'About the same', 'Slower', 'Not sure'] },
    { id: 'q7', section: 'Using SpinFamily', type: 'yesno', text: 'Did your family do an activity SpinFamily suggested?' },
    { id: 'q8', section: 'Using SpinFamily', type: 'text', text: 'If anything got in the way of doing the activity, what was it?' },
    { id: 'q9', section: 'Coming back', type: 'yesno', text: 'Have you opened SpinFamily again since your first time?' },
    { id: 'q10', section: 'Coming back', type: 'scale', text: 'How likely are you to use SpinFamily again?', min: 1, max: 5, minLabel: 'Not likely', maxLabel: 'Very likely' },
    { id: 'q11', section: 'Coming back', type: 'text', text: 'What would make SpinFamily more useful for your family?' },
    { id: 'q12', section: 'Plans and pricing', type: 'text', text: 'Which extra features, if any, would be worth having?' },
    { id: 'q13', section: 'Plans and pricing', type: 'choice', text: 'Would you consider paying $7 a month or $75 a year for extra features?', options: ['Yes', 'Maybe', 'No', 'Not sure yet'] },
    { id: 'q14', section: 'Plans and pricing', type: 'text', text: 'What shaped your answer to the last question?' },
    { id: 'q15', section: 'Anything else', type: 'text', text: 'Is there anything else you\'d like us to know?' },
  ],
};

function validateQuestions(qs) {
  if (!Array.isArray(qs) || !qs.length || qs.length > 40) throw new Invalid('Add between 1 and 40 questions');
  const ids = new Set();
  return qs.map((q, i) => {
    const id = text(q?.id, `Question ${i + 1} id`, 20, { required: true });
    if (!/^[\w-]+$/.test(id) || ids.has(id)) throw new Invalid(`Question ${i + 1} needs a unique id`); ids.add(id);
    const out = { id, section: text(q.section, 'Section', 60), type: oneOf(q.type, `Question ${i + 1} type`, QTYPES), text: text(q.text, `Question ${i + 1}`, 300, { required: true }) };
    if (out.type === 'choice') { if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 10) throw new Invalid(`Question ${i + 1} needs 2–10 options`); out.options = q.options.map((o, j) => text(o, `Option ${j + 1}`, 80, { required: true })); }
    if (out.type === 'scale') { out.min = 1; out.max = Math.min(10, Math.max(3, Number(q.max) || 5)); out.minLabel = text(q.minLabel, 'Low label', 40); out.maxLabel = text(q.maxLabel, 'High label', 40); }
    return out;
  });
}
function validateAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Invalid('Answers are missing');
  const out = {};
  for (const q of questions) {
    const v = answers[q.id];
    if (v === undefined || v === null || v === '') continue; // all optional
    if (q.type === 'text') out[q.id] = text(v, q.text.slice(0, 30), 2000);
    else if (q.type === 'yesno') out[q.id] = oneOf(v, 'answer', ['yes', 'no']);
    else if (q.type === 'choice') out[q.id] = oneOf(v, 'answer', q.options);
    else if (q.type === 'scale') { const n = Number(v); if (!Number.isInteger(n) || n < q.min || n > q.max) throw new Invalid('Pick a number on the scale'); out[q.id] = n; }
  }
  for (const k of Object.keys(answers)) if (!questions.some(q => q.id === k)) throw new Invalid('Unexpected answer');
  return out;
}

const toSurvey = r => { const s = row(r); return { id: s.id, title: s.title, version: s.version, revision: s.revision, status: s.status, intro: s.intro, questions: s.questions, approvedBy: s.approved_by, approvedAt: s.approved_at, createdAt: s.created_at }; };
async function seedSurvey(env) {
  const seeded = await env.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${env.orgId}, 'survey_seeded', ${asJson({ at: iso(env.now()) })}::jsonb) ON CONFLICT DO NOTHING RETURNING key`;
  if (!seeded[0]) return;
  await env.sql`INSERT INTO survey_definitions (id, org_id, title, version, status, intro, questions, created_by, created_at)
    VALUES (${newId('sv')}, ${env.orgId}, ${DRAFT_QUESTIONNAIRE.title}, 1, 'draft', ${DRAFT_QUESTIONNAIRE.intro}, ${asJson(DRAFT_QUESTIONNAIRE.questions)}::jsonb, 'spec:SF-PILOT-OPS-001', ${iso(env.now())})`;
}
async function getSurvey(env, id) { const r = (await env.sql`SELECT * FROM survey_definitions WHERE id = ${id} AND org_id = ${env.orgId}`)[0]; return r ? toSurvey(r) : null; }
const toCohort = r => { const c = row(r); return { id: c.id, name: c.name, partner: c.partner, description: c.description, protocol: c.protocol, plannedSize: c.planned_size, deadline: c.deadline, status: c.status, createdAt: c.created_at, enrolled: Number(c.enrolled || 0), sessionsDone: Number(c.sessions_done || 0) }; };

// Coordinators see totals only, and never a group smaller than 5: whole results are withheld below
// 5 responses, and any answer chosen by 1–4 people shows as "<5". If only one answer in a question
// would be hidden, the next smallest is hidden too, so it can't be worked out by subtraction.
export function summarize(questions, responses, { includeText, suppress = false }) {
  return questions.map(q => {
    const vals = responses.map(r => r.answers[q.id]).filter(v => v !== undefined);
    const base = { id: q.id, text: q.text, type: q.type, answered: suppress && vals.length < SMALL_CELL ? '<5' : vals.length };
    if (q.type === 'text') return { ...base, answers: includeText ? vals : [], note: includeText ? null : 'Written answers are visible to Dion only.' };
    let counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    let avg = q.type === 'scale' && vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
    if (suppress) {
      if (vals.length < SMALL_CELL) return { ...base, counts: {}, average: null, note: 'Fewer than 5 answers: hidden.' };
      const small = Object.keys(counts).filter(k => counts[k] < SMALL_CELL);
      if (small.length === 1) {
        const next = Object.keys(counts).filter(k => !small.includes(k)).sort((a, b) => counts[a] - counts[b])[0];
        if (next) small.push(next);
      }
      counts = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, small.includes(k) ? '<5' : n]));
    }
    return { ...base, counts, average: avg };
  });
}

export async function researchRoutes(parts, method, body, env) {
  const me = env.member;
  env.need('research.view');
  await seedSurvey(env);
  const route = parts[0];

  if (method === 'GET' && !route) {
    const cohorts = (await env.sql`SELECT c.id, c.name, c.partner, c.description, c.protocol, c.planned_size, c.deadline::text AS deadline, c.status, c.created_at,
      (SELECT count(*) FROM research_enrollments e WHERE e.cohort_id = c.id AND e.status <> 'withdrawn') AS enrolled,
      (SELECT count(*) FROM research_sessions s WHERE s.cohort_id = c.id AND s.completed_at IS NOT NULL) AS sessions_done
      FROM research_cohorts c WHERE c.org_id = ${env.orgId} ORDER BY c.created_at`).map(toCohort);
    const surveys = (await env.sql`SELECT * FROM survey_definitions WHERE org_id = ${env.orgId} ORDER BY title, version DESC`).map(toSurvey);
    const stats = rows(await env.sql`SELECT survey_id, count(*)::int AS responses FROM survey_responses WHERE org_id = ${env.orgId} GROUP BY survey_id`);
    const invites = rows(await env.sql`SELECT survey_id, count(*)::int AS invites FROM survey_invites WHERE org_id = ${env.orgId} GROUP BY survey_id`);
    for (const s of surveys) { s.responses = stats.find(x => x.survey_id === s.id)?.responses || 0; s.invites = invites.find(x => x.survey_id === s.id)?.invites || 0; }
    return json({ cohorts, surveys, cohortStatuses: COHORT_STATUS, sessionKinds: SESSION_KINDS, enrollStatuses: ENROLL_STATUS, notice: await noticeState(env), researchEnabled: !!env.features?.has('research') });
  }

  // ----- Participation notice (founder approves each version) -----
  if (route === 'notice' && method === 'POST' && parts[1] === 'approve') {
    env.need('research.notice.approve');
    if (body.version !== RESEARCH_NOTICE.version) throw new Invalid('That is not the current notice. Reload and review it again.');
    await inTx(env, async t => {
      await t.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${t.orgId}, 'research_notice', ${asJson({ version: RESEARCH_NOTICE.version, digest: sha256(JSON.stringify(RESEARCH_NOTICE.text)), approvedAt: iso(t.now()), approvedBy: me.id })}::jsonb)
        ON CONFLICT (org_id, key) DO UPDATE SET value = excluded.value`;
      await t.audit('research.notice_approved', null, { version: RESEARCH_NOTICE.version });
    });
    return json({ notice: await noticeState(env) });
  }

  // ----- Consent the founder holds in writing -----
  if (route === 'consents' && method === 'POST') {
    env.need('research.consent.record');
    const p = await getParticipant(env, text(body.participantId, 'participant', 40, { required: true }));
    if (!p) throw new Invalid('Unknown participant');
    if (p.withdrawnAt) throw new Invalid('This person withdrew');
    const evidence = text(body.evidence, 'Where the written consent is kept', 300, { required: true });
    const noticeVersion = oneOf(body.noticeVersion, 'notice version', [RESEARCH_NOTICE.version]);
    await inTx(env, async t => {
      await t.sql`INSERT INTO research_consents (id, org_id, participant_id, purpose, notice_version, method, evidence, given_at, recorded_by) VALUES (${newId('rcn')}, ${t.orgId}, ${p.id}, 'pilot_research', ${noticeVersion}, 'founder_recorded_written', ${evidence}, ${iso(t.now())}, ${me.id})`;
      await t.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${t.orgId}, ${p.id}, ${iso(t.now())}, ${me.id}, ${asJson([{ field: 'research consent', to: `recorded from written consent (${noticeVersion})` }])}::jsonb)`;
      await t.audit('research.consent_recorded', p.id);
    });
    return json({ ok: true }, 201);
  }

  // ----- Cohorts -----
  if (route === 'cohorts') {
    if (method === 'POST' && !parts[1]) {
      env.need('research.manage');
      const now = iso(env.now()), id = newId('rc');
      await env.sql`INSERT INTO research_cohorts (id, org_id, name, partner, description, protocol, planned_size, deadline, status, created_at, updated_at)
        VALUES (${id}, ${env.orgId}, ${text(body.name, 'Name', 120, { required: true })}, ${text(body.partner, 'Partner', 120)}, ${text(body.description, 'Description', 1000)}, ${text(body.protocol, 'Protocol', 3000)},
        ${count(body.plannedSize, 'Planned size', 1000)}, ${date(body.deadline, 'deadline')}, ${oneOf(body.status, 'status', COHORT_STATUS, 'planned')}, ${now}, ${now})`;
      await env.audit('research.cohort_created', id);
      return json({ id }, 201);
    }
    const c = parts[1] && (await env.sql`SELECT id, status FROM research_cohorts WHERE id = ${parts[1]} AND org_id = ${env.orgId}`)[0];
    if (!c) return notFound();
    if (method === 'GET' && !parts[2]) {
      const enrolled = await env.sql`SELECT e.participant_id, e.status, p.first_name, p.assigned_to,
        (SELECT min(given_at) FROM research_consents rc WHERE rc.participant_id = e.participant_id AND rc.withdrawn_at IS NULL) AS consent_at
        FROM research_enrollments e JOIN participants p ON p.id = e.participant_id WHERE e.cohort_id = ${c.id} ORDER BY e.created_at LIMIT 500`;
      const visible = env.has('participants.view.all') ? enrolled : enrolled.filter(e => e.assigned_to === me.id);
      const sessions = rows(await env.sql`SELECT id, participant_id, kind, scheduled_for::text AS scheduled_for, completed_at, observations, created_by FROM research_sessions WHERE cohort_id = ${c.id} ORDER BY scheduled_for NULLS LAST, created_at LIMIT 1000`);
      const ids = new Set(visible.map(e => e.participant_id));
      return json({ enrollments: rows(visible).map(e => ({ participantId: e.participant_id, firstName: e.first_name, status: e.status, consentAt: e.consent_at })), hiddenCount: enrolled.length - visible.length, sessions: sessions.filter(s => ids.has(s.participant_id)) });
    }
    if (method === 'PATCH' && !parts[2]) {
      env.need('research.manage');
      await env.sql`UPDATE research_cohorts SET status = ${oneOf(body.status, 'status', COHORT_STATUS)}, updated_at = ${iso(env.now())} WHERE id = ${c.id}`;
      await env.audit('research.cohort_updated', c.id);
      return json({ ok: true });
    }
    if (method === 'POST' && parts[2] === 'enroll') {
      const p = await getParticipant(env, text(body.participantId, 'participant', 40, { required: true }));
      if (!p) throw new Invalid('Unknown participant');
      if (me.role !== 'founder' && p.assignedTo !== me.id) throw new Invalid('You can only add participants assigned to you');
      if (p.withdrawnAt) throw new Invalid('This person withdrew');
      if (p.isTest !== false) throw new Invalid('Review this record (not a test) before adding it to research');
      const status = oneOf(body.status, 'status', ENROLL_STATUS, 'invited');
      if (status === 'completed') env.need('research.manage');
      await inTx(env, async t => {
        // A withdrawal stays a withdrawal: re-adding someone who withdrew is refused.
        const prev = (await t.sql`SELECT status FROM research_enrollments WHERE cohort_id = ${c.id} AND participant_id = ${p.id} FOR UPDATE`)[0];
        if (prev?.status === 'withdrawn' && status !== 'withdrawn') throw new Invalid('They withdrew from this research. They can only rejoin by telling Dion directly.');
        await t.sql`INSERT INTO research_enrollments (org_id, cohort_id, participant_id, status, consent_at, created_at) VALUES (${t.orgId}, ${c.id}, ${p.id}, ${status}, NULL, ${iso(t.now())})
          ON CONFLICT (cohort_id, participant_id) DO UPDATE SET status = excluded.status`;
        if (status === 'withdrawn') await t.sql`UPDATE survey_invites SET revoked_at = ${t.now()} WHERE org_id = ${t.orgId} AND participant_id = ${p.id} AND cohort_id = ${c.id} AND used_at IS NULL AND revoked_at IS NULL`;
        await t.audit('research.enrolled', c.id, { participant: p.id, status });
      });
      return json({ ok: true }, 201);
    }
  }

  // ----- Sessions -----
  if (route === 'sessions' && method === 'POST') {
    env.need('research.sessions');
    const cohort = (await env.sql`SELECT id FROM research_cohorts WHERE id = ${text(body.cohortId, 'cohort', 40, { required: true })} AND org_id = ${env.orgId}`)[0];
    if (!cohort) throw new Invalid('Unknown cohort');
    const p = await getParticipant(env, text(body.participantId, 'participant', 40, { required: true }));
    if (!p || (me.role !== 'founder' && p.assignedTo !== me.id)) throw new Invalid('Unknown participant');
    if (!(await env.sql`SELECT 1 FROM research_enrollments WHERE cohort_id = ${cohort.id} AND participant_id = ${p.id} AND status <> 'withdrawn'`)[0]) throw new Invalid('Add them to the cohort first');
    const id = newId('rs');
    await env.sql`INSERT INTO research_sessions (id, org_id, cohort_id, participant_id, kind, scheduled_for, completed_at, observations, created_by, created_at)
      VALUES (${id}, ${env.orgId}, ${cohort.id}, ${p.id}, ${oneOf(body.kind, 'kind', SESSION_KINDS, 'initial')}, ${date(body.scheduledFor, 'date')}, ${body.completed === true ? iso(env.now()) : null}, ${text(body.observations, 'Observations', 3000)}, ${me.id}, ${iso(env.now())})`;
    await env.audit('research.session_logged', id);
    return json({ id }, 201);
  }

  // ----- Surveys -----
  if (route === 'surveys' && parts[1]) {
    const s = await getSurvey(env, parts[1]); if (!s) return notFound();
    if (method === 'PATCH' && !parts[2]) {
      env.need('surveys.draft');
      const questions = body.questions !== undefined ? validateQuestions(body.questions) : s.questions;
      const intro = body.intro !== undefined ? text(body.intro, 'Introduction', 1000) : s.intro;
      if (s.status === 'draft') {
        // Editing a draft starts a new revision and replaces any approval request for the old one (R2-04).
        await inTx(env, async t => {
          const r = await t.sql`UPDATE survey_definitions SET questions = ${asJson(questions)}::jsonb, intro = ${intro}, revision = revision + 1 WHERE id = ${s.id} AND status = 'draft' AND revision = ${Number.isInteger(body.revision) ? body.revision : s.revision} RETURNING id`;
          if (!r[0]) { const e = new Error('conflict'); e.conflict = true; throw e; }
          await supersedePending(t, 'survey', s.id);
          await t.audit('survey.draft_edited', s.id);
        });
        return json({ survey: await getSurvey(env, s.id) });
      }
      // Approved versions are never edited: changes become a new draft version. Answers keep their version.
      const v = (await env.sql`SELECT coalesce(max(version), 0)::int + 1 AS v FROM survey_definitions WHERE org_id = ${env.orgId} AND title = ${s.title}`)[0].v;
      const id = newId('sv');
      await env.sql`INSERT INTO survey_definitions (id, org_id, title, version, status, intro, questions, created_by, created_at) VALUES (${id}, ${env.orgId}, ${s.title}, ${v}, 'draft', ${intro}, ${asJson(questions)}::jsonb, ${me.id}, ${iso(env.now())})`;
      await env.audit('survey.new_version', id, { version: v });
      return json({ survey: await getSurvey(env, id) }, 201);
    }
    if (method === 'POST' && parts[2] === 'submit') {
      env.need('surveys.draft');
      if (s.status !== 'draft') throw new Invalid('Only drafts can be sent for approval');
      await submitForApproval(env, { itemType: 'survey', itemId: s.id, title: `${s.title} v${s.version}`, summary: `${s.questions.length} questions (revision ${s.revision}). Needs approval before any parent sees it.` });
      return json({ ok: true });
    }
    if (method === 'GET' && parts[2] === 'results') {
      env.need('responses.view.aggregate');
      const full = env.has('responses.view.full');
      // Only answers from people who have not withdrawn and still consent are reported.
      const resp = rows(await env.sql`SELECT r.id, r.answers, r.submitted_at, r.participant_id, p.first_name FROM survey_responses r JOIN participants p ON p.id = r.participant_id
        WHERE r.survey_id = ${s.id} AND p.withdrawn_at IS NULL AND EXISTS (SELECT 1 FROM research_consents c WHERE c.participant_id = r.participant_id AND c.withdrawn_at IS NULL) ORDER BY r.submitted_at LIMIT 5000`);
      return json({ survey: s, responses: !full && resp.length < SMALL_CELL ? '<5' : resp.length, summary: summarize(s.questions, resp, { includeText: full, suppress: !full }), individual: full ? resp.map(r => ({ firstName: r.first_name, submittedAt: r.submitted_at, answers: r.answers })) : null });
    }
  }

  // ----- Survey links (one active per participant and questionnaire, single use, 30 days) -----
  if (route === 'invites' && method === 'POST') {
    env.need('research.invite');
    if (!env.features?.has('research')) throw new Invalid('Survey links are switched off until research is approved for real families (OPS_FEATURES).');
    const notice = await noticeState(env);
    if (!notice.approvedCurrent) throw new Invalid('Dion needs to approve the participation notice first (Research & testing).');
    const surveyId = text(body.surveyId, 'survey', 40, { required: true });
    const participantId = text(body.participantId, 'participant', 40, { required: true });
    const cohortId = body.cohortId ? text(body.cohortId, 'cohort', 40) : null;
    const token = newToken();
    await inTx(env, async t => {
      // Lock the person, then check every eligibility rule against what is true right now.
      const p = (await t.sql`SELECT id, assigned_to, is_test, withdrawn_at, communication FROM participants WHERE id = ${participantId} AND org_id = ${t.orgId} FOR UPDATE`)[0];
      if (!p || (me.role !== 'founder' && p.assigned_to !== me.id)) throw new Invalid('Unknown participant');
      if (p.is_test !== false) throw new Invalid(p.is_test ? 'That record is marked as a test' : 'Review this record (not a test) first');
      if (p.withdrawn_at) throw new Invalid('This person withdrew');
      if (p.communication === 'opted_out') throw new Invalid('This person opted out of emails');
      const s = (await t.sql`SELECT id, title, status FROM survey_definitions WHERE id = ${surveyId} AND org_id = ${t.orgId} FOR SHARE`)[0];
      if (!s || s.status !== 'approved') throw new Invalid('Only an approved questionnaire can be sent. Send the draft to Dion for approval first.');
      if (cohortId) {
        const e = (await t.sql`SELECT status FROM research_enrollments WHERE cohort_id = ${cohortId} AND participant_id = ${p.id} AND org_id = ${t.orgId}`)[0];
        if (!e) throw new Invalid('They are not in that cohort');
        if (e.status === 'withdrawn') throw new Invalid('They withdrew from that cohort');
      }
      if ((await t.sql`SELECT 1 FROM research_withdrawals WHERE participant_id = ${p.id} AND org_id = ${t.orgId}`)[0]) throw new Invalid('They withdrew from research');
      if ((await t.sql`SELECT 1 FROM survey_responses r JOIN survey_definitions d ON d.id = r.survey_id WHERE d.title = ${s.title} AND r.participant_id = ${p.id} AND r.org_id = ${t.orgId}`)[0]) throw new Invalid('They already answered this questionnaire');
      // A new link replaces any earlier unused one for this questionnaire.
      await t.sql`UPDATE survey_invites SET revoked_at = ${t.now()} WHERE org_id = ${t.orgId} AND participant_id = ${p.id} AND used_at IS NULL AND revoked_at IS NULL AND survey_id IN (SELECT id FROM survey_definitions WHERE title = ${s.title} AND org_id = ${t.orgId})`;
      await t.sql`INSERT INTO survey_invites (token_hash, org_id, survey_id, participant_id, cohort_id, created_by, created_at, expires_at, notice_version) VALUES (${sha256(token)}, ${t.orgId}, ${s.id}, ${p.id}, ${cohortId}, ${me.id}, ${iso(t.now())}, ${t.now() + SURVEY_LINK_TTL_MS}, ${RESEARCH_NOTICE.version})`;
      await t.audit('survey.link_created', s.id, { participant: p.id });
    });
    // Shown once to the person who created it; only a hash is stored.
    return json({ link: `${env.origin}/pilot/survey/#t=${token}`, expiresInDays: 30 }, 201);
  }
  return notFound();
}

// ---------- Public endpoints used by the parent's survey page (token only; no sign-in) ----------
// Every check is repeated at submit time inside one transaction: link unused, not revoked, not
// expired; questionnaire still approved; notice still the approved version; person not withdrawn;
// consent on file or given now. The response insert and the link claim commit together.
async function readInvite(sql, orgId, hash, lock) {
  const q = lock
    ? sql`SELECT i.token_hash, i.survey_id, i.participant_id, i.cohort_id, i.expires_at, i.used_at, i.revoked_at, i.notice_version, s.status, s.title, s.intro, s.questions, s.version, p.withdrawn_at, p.is_test
        FROM survey_invites i JOIN survey_definitions s ON s.id = i.survey_id JOIN participants p ON p.id = i.participant_id WHERE i.token_hash = ${hash} AND i.org_id = ${orgId} FOR UPDATE OF i, p`
    : sql`SELECT i.token_hash, i.survey_id, i.participant_id, i.cohort_id, i.expires_at, i.used_at, i.revoked_at, i.notice_version, s.status, s.title, s.intro, s.questions, s.version, p.withdrawn_at, p.is_test
        FROM survey_invites i JOIN survey_definitions s ON s.id = i.survey_id JOIN participants p ON p.id = i.participant_id WHERE i.token_hash = ${hash} AND i.org_id = ${orgId}`;
  return (await q)[0] || null;
}
function inviteLive(inv, now, notice) {
  return !!inv && inv.used_at === null && inv.revoked_at === null && now <= Number(inv.expires_at) && inv.status === 'approved' && !inv.withdrawn_at && inv.is_test === false
    && notice.approvedCurrent && inv.notice_version === notice.current.version;
}
const activeConsent = async (sql, orgId, pid) => (await sql`SELECT id FROM research_consents WHERE org_id = ${orgId} AND participant_id = ${pid} AND purpose = 'pilot_research' AND withdrawn_at IS NULL`)[0]?.id || null;

export async function publicSurveyRoutes(parts, method, body, deps) {
  if (parts[0] !== 'survey' || method !== 'POST') return null;
  const token = typeof body.token === 'string' && /^[\w-]{20,100}$/.test(body.token) ? body.token : '';
  const noStore = { headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } };
  const gone = () => fail(400, 'link_invalid', 'This survey link has expired or was already used. Thank you — if you think this is a mistake, reply to the email you got from SpinFamily.');
  if (!token) return gone();
  const hash = sha256(token);
  const notice = await noticeState(deps);

  if (parts[1] === 'load') {
    const inv = await readInvite(deps.sql, deps.orgId, hash, false);
    if (!inviteLive(inv, deps.now(), notice)) return gone();
    return Response.json({ title: inv.title, intro: inv.intro, questions: inv.questions, notice: notice.current, consentOnFile: !!(await activeConsent(deps.sql, deps.orgId, inv.participant_id)) }, noStore);
  }
  if (parts[1] === 'submit') {
    const r = await inTx(deps, async t => {
      const inv = await readInvite(t.sql, t.orgId, hash, true);
      await barrier(t, 'survey.submit.locked');
      if (!inviteLive(inv, t.now(), notice)) return { gone: true };
      const answers = validateAnswers(inv.questions, body.answers);
      if ((await t.sql`SELECT 1 FROM survey_responses WHERE org_id = ${t.orgId} AND participant_id = ${inv.participant_id} AND survey_id = ${inv.survey_id}`)[0]) return { gone: true };
      let consentId = await activeConsent(t.sql, t.orgId, inv.participant_id);
      if (!consentId) {
        if (body.consent !== true || body.noticeVersion !== notice.current.version) return { consentRequired: true };
        consentId = newId('rcn');
        await t.sql`INSERT INTO research_consents (id, org_id, participant_id, purpose, notice_version, method, evidence, given_at, recorded_by) VALUES (${consentId}, ${t.orgId}, ${inv.participant_id}, 'pilot_research', ${notice.current.version}, 'participant_survey_page', 'Ticked the consent box on the survey page', ${iso(t.now())}, 'participant')`;
      }
      const at = iso(t.now());
      await t.sql`UPDATE survey_invites SET used_at = ${t.now()} WHERE token_hash = ${hash}`;
      await barrier(t, 'survey.submit.before_insert');
      await t.sql`INSERT INTO survey_responses (id, org_id, survey_id, survey_version, participant_id, cohort_id, answers, submitted_at, consent_id) VALUES (${newId('sr')}, ${t.orgId}, ${inv.survey_id}, ${inv.version}, ${inv.participant_id}, ${inv.cohort_id}, ${asJson(answers)}::jsonb, ${at}, ${consentId})`;
      await t.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${t.orgId}, ${inv.participant_id}, ${at}, 'survey', ${asJson([{ field: 'survey', to: `submitted ${inv.title} v${inv.version}` }])}::jsonb)`;
      return { ok: true };
    });
    if (r.consentRequired) return fail(400, 'consent_required', 'Please read the notice and tick the box to take part.');
    if (r.gone) return gone();
    return Response.json({ ok: true }, noStore);
  }
  if (parts[1] === 'withdraw') {
    // Works from any link they were sent (even used), until it expires.
    const r = await inTx(deps, async t => {
      const inv = await readInvite(t.sql, t.orgId, hash, true);
      if (!inv || t.now() > Number(inv.expires_at)) return null;
      await t.sql`UPDATE research_consents SET withdrawn_at = ${iso(t.now())}, withdrawal_method = 'participant_survey_page', withdrawal_by = 'participant' WHERE org_id = ${t.orgId} AND participant_id = ${inv.participant_id} AND withdrawn_at IS NULL`;
      await t.sql`UPDATE research_enrollments SET status = 'withdrawn' WHERE org_id = ${t.orgId} AND participant_id = ${inv.participant_id}`;
      await t.sql`UPDATE survey_invites SET revoked_at = ${t.now()} WHERE org_id = ${t.orgId} AND participant_id = ${inv.participant_id} AND used_at IS NULL AND revoked_at IS NULL`;
      await t.sql`INSERT INTO research_withdrawals (id, org_id, participant_id, method, recorded_by, at) VALUES (${newId('rw')}, ${t.orgId}, ${inv.participant_id}, 'participant_survey_page', 'participant', ${iso(t.now())})`;
      await t.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${t.orgId}, ${inv.participant_id}, ${iso(t.now())}, 'participant', ${asJson([{ field: 'research', to: 'withdrew on the survey page' }])}::jsonb)`;
      await t.sql`INSERT INTO audit_events (org_id, at, actor, action, target, extra) VALUES (${t.orgId}, ${iso(t.now())}, 'participant', 'research.withdrawn', ${inv.participant_id}, '{}'::jsonb)`;
      return true;
    });
    if (!r) return gone();
    return Response.json({ ok: true, message: 'You have withdrawn. We won\'t ask you any more research questions. To have your earlier answers removed, reply to any SpinFamily email.' }, noStore);
  }
  return null;
}
