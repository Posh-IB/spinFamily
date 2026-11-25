// Research & testing: cohorts (e.g. Marilyn's parent-testing program), sessions, a versioned questionnaire
// that needs founder approval before use, one-time survey links, and response summaries.
import { sha256, newToken } from './security.mjs';
import { json, fail, notFound, Invalid, newId, iso, text, oneOf, date, count, row, rows, asJson } from './util.mjs';
import { getParticipant } from './records.mjs';
import { submitForApproval } from './approvals.mjs';

const COHORT_STATUS = ['planned', 'active', 'completed', 'cancelled'];
const ENROLL_STATUS = ['invited', 'consented', 'active', 'completed', 'withdrawn'];
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

const toSurvey = r => { const s = row(r); return { id: s.id, title: s.title, version: s.version, status: s.status, intro: s.intro, questions: s.questions, approvedBy: s.approved_by, approvedAt: s.approved_at, createdAt: s.created_at }; };
async function seedSurvey(env) {
  const seeded = await env.sql`INSERT INTO org_meta (org_id, key, value) VALUES (${env.orgId}, 'survey_seeded', ${asJson({ at: iso(env.now()) })}::jsonb) ON CONFLICT DO NOTHING RETURNING key`;
  if (!seeded[0]) return;
  await env.sql`INSERT INTO survey_definitions (id, org_id, title, version, status, intro, questions, created_by, created_at)
    VALUES (${newId('sv')}, ${env.orgId}, ${DRAFT_QUESTIONNAIRE.title}, 1, 'draft', ${DRAFT_QUESTIONNAIRE.intro}, ${asJson(DRAFT_QUESTIONNAIRE.questions)}::jsonb, 'spec:SF-PILOT-OPS-001', ${iso(env.now())})`;
}
async function getSurvey(env, id) { const r = (await env.sql`SELECT * FROM survey_definitions WHERE id = ${id} AND org_id = ${env.orgId}`)[0]; return r ? toSurvey(r) : null; }
const toCohort = r => { const c = row(r); return { id: c.id, name: c.name, partner: c.partner, description: c.description, protocol: c.protocol, plannedSize: c.planned_size, deadline: c.deadline, status: c.status, createdAt: c.created_at, enrolled: Number(c.enrolled || 0), sessionsDone: Number(c.sessions_done || 0) }; };

function summarize(questions, responses, { includeText }) {
  return questions.map(q => {
    const vals = responses.map(r => r.answers[q.id]).filter(v => v !== undefined);
    const base = { id: q.id, text: q.text, type: q.type, answered: vals.length };
    if (q.type === 'text') return { ...base, answers: includeText ? vals : [], note: includeText ? null : 'Written answers are visible to Dion only.' };
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const avg = q.type === 'scale' && vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
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
    return json({ cohorts, surveys, cohortStatuses: COHORT_STATUS, sessionKinds: SESSION_KINDS });
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
      const enrolled = await env.sql`SELECT e.participant_id, e.status, e.consent_at, p.first_name, p.assigned_to FROM research_enrollments e JOIN participants p ON p.id = e.participant_id WHERE e.cohort_id = ${c.id} ORDER BY e.created_at`;
      const visible = env.has('participants.view.all') ? enrolled : enrolled.filter(e => e.assigned_to === me.id);
      const sessions = rows(await env.sql`SELECT id, participant_id, kind, scheduled_for::text AS scheduled_for, completed_at, observations, created_by FROM research_sessions WHERE cohort_id = ${c.id} ORDER BY scheduled_for NULLS LAST, created_at`);
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
      const status = oneOf(body.status, 'status', ENROLL_STATUS, 'invited');
      await env.sql`INSERT INTO research_enrollments (org_id, cohort_id, participant_id, status, consent_at, created_at) VALUES (${env.orgId}, ${c.id}, ${p.id}, ${status}, ${status === 'consented' || status === 'active' ? iso(env.now()) : null}, ${iso(env.now())})
        ON CONFLICT (cohort_id, participant_id) DO UPDATE SET status = excluded.status, consent_at = coalesce(research_enrollments.consent_at, excluded.consent_at)`;
      await env.audit('research.enrolled', c.id, { participant: p.id, status });
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
        await env.sql`UPDATE survey_definitions SET questions = ${asJson(questions)}::jsonb, intro = ${intro} WHERE id = ${s.id} AND status = 'draft'`;
        await env.audit('survey.draft_edited', s.id);
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
      await submitForApproval(env, { itemType: 'survey', itemId: s.id, title: `${s.title} v${s.version}`, summary: `${s.questions.length} questions. Needs approval before any parent sees it.` });
      return json({ ok: true });
    }
    if (method === 'GET' && parts[2] === 'results') {
      env.need('responses.view.aggregate');
      const full = env.has('responses.view.full');
      const resp = rows(await env.sql`SELECT r.id, r.answers, r.submitted_at, r.participant_id, p.first_name FROM survey_responses r JOIN participants p ON p.id = r.participant_id WHERE r.survey_id = ${s.id} ORDER BY r.submitted_at`);
      return json({ survey: s, responses: resp.length, summary: summarize(s.questions, resp, { includeText: full }), individual: full ? resp.map(r => ({ firstName: r.first_name, submittedAt: r.submitted_at, answers: r.answers })) : null });
    }
  }

  // ----- Survey links (one per participant, single use, 30 days) -----
  if (route === 'invites' && method === 'POST') {
    env.need('research.invite');
    const s = await getSurvey(env, text(body.surveyId, 'survey', 40, { required: true }));
    if (!s || s.status !== 'approved') throw new Invalid('Only an approved questionnaire can be sent. Send the draft to Dion for approval first.');
    const p = await getParticipant(env, text(body.participantId, 'participant', 40, { required: true }));
    if (!p || (me.role !== 'founder' && p.assignedTo !== me.id)) throw new Invalid('Unknown participant');
    if (p.isTest === true) throw new Invalid('That record is marked as a test');
    const cohortId = body.cohortId ? text(body.cohortId, 'cohort', 40) : null;
    if (cohortId && !(await env.sql`SELECT 1 FROM research_enrollments WHERE cohort_id = ${cohortId} AND participant_id = ${p.id}`)[0]) throw new Invalid('They are not in that cohort');
    if ((await env.sql`SELECT 1 FROM survey_responses WHERE survey_id = ${s.id} AND participant_id = ${p.id}`)[0]) throw new Invalid('They already answered this questionnaire');
    const token = newToken();
    await env.sql`INSERT INTO survey_invites (token_hash, org_id, survey_id, participant_id, cohort_id, created_by, created_at, expires_at) VALUES (${sha256(token)}, ${env.orgId}, ${s.id}, ${p.id}, ${cohortId}, ${me.id}, ${iso(env.now())}, ${env.now() + SURVEY_LINK_TTL_MS})`;
    await env.audit('survey.link_created', s.id, { participant: p.id });
    // Shown once to the person who created it; only a hash is stored.
    return json({ link: `${env.origin}/pilot/survey/#t=${token}`, expiresInDays: 30 }, 201);
  }
  return notFound();
}

// ---------- Public endpoints used by the parent's survey page (token only; no sign-in) ----------
export async function publicSurveyRoutes(parts, method, body, deps) {
  if (parts[0] !== 'survey' || method !== 'POST') return null;
  const token = typeof body.token === 'string' && /^[\w-]{20,100}$/.test(body.token) ? body.token : '';
  const gone = () => fail(400, 'link_invalid', 'This survey link has expired or was already used. Thank you — if you think this is a mistake, reply to the email you got from SpinFamily.');
  if (!token) return gone();
  const inv = (await deps.sql`SELECT i.token_hash, i.survey_id, i.participant_id, i.cohort_id, i.expires_at, i.used_at, s.status, s.title, s.intro, s.questions, s.version
    FROM survey_invites i JOIN survey_definitions s ON s.id = i.survey_id WHERE i.token_hash = ${sha256(token)} AND i.org_id = ${deps.orgId}`)[0];
  if (!inv || inv.used_at !== null || deps.now() > Number(inv.expires_at) || inv.status !== 'approved') return gone();
  if (parts[1] === 'load') return Response.json({ title: inv.title, intro: inv.intro, questions: inv.questions }, { headers: { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
  if (parts[1] === 'submit') {
    const answers = validateAnswers(inv.questions, body.answers);
    const claimed = await deps.sql`UPDATE survey_invites SET used_at = ${deps.now()} WHERE token_hash = ${inv.token_hash} AND used_at IS NULL RETURNING token_hash`;
    if (!claimed[0]) return gone();
    const at = iso(deps.now());
    await deps.sql`INSERT INTO survey_responses (id, org_id, survey_id, survey_version, participant_id, cohort_id, answers, submitted_at) VALUES (${newId('sr')}, ${deps.orgId}, ${inv.survey_id}, ${inv.version}, ${inv.participant_id}, ${inv.cohort_id}, ${asJson(answers)}::jsonb, ${at})`;
    await deps.sql`INSERT INTO participant_history (org_id, participant_id, at, actor, changes) VALUES (${deps.orgId}, ${inv.participant_id}, ${at}, 'survey', ${asJson([{ field: 'survey', to: `submitted ${inv.title} v${inv.version}` }])}::jsonb)`;
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  }
  return null;
}
