// SpinFamily Pilot Operations workspace (front end).
// No third-party code, no analytics, no browser storage. The server decides every permission;
// this file only hides buttons the server would refuse anyway.
(() => {
'use strict';
const app = document.getElementById('app');
let ME = null;

// ---------- tiny DOM helper (builds text nodes only; never parses data as HTML) ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const clear = el => { while (el.firstChild) el.firstChild.remove(); return el; };
function toast(msg) { document.querySelectorAll('.toast').forEach(x => x.remove()); const t = h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t); setTimeout(() => t.remove(), 2600); }

// ---------- API ----------
async function api(method, path, body) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) { opts.headers['content-type'] = 'application/json'; opts.headers['x-sf-ops'] = '1'; opts.body = JSON.stringify(body); }
  else if (method !== 'GET') { opts.headers['content-type'] = 'application/json'; opts.headers['x-sf-ops'] = '1'; opts.body = '{}'; }
  const r = await fetch('/operations/api/' + path, opts);
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) {
    const code = data?.error?.code;
    if (r.status === 401 && path !== 'auth/me' && !path.startsWith('auth/')) { ME = null; route(); }
    const e = new Error(data?.error?.message || 'Something went wrong.'); e.code = code; e.status = r.status; throw e;
  }
  return data;
}

// ---------- labels ----------
const LABEL = {
  prospect: 'Prospect', registration_received: 'Registration received', eligibility_confirmed: 'Eligibility confirmed', enrolled: 'Enrolled', withdrawn: 'Withdrawn', archived: 'Archived',
  pilot: 'Pilot', beta: 'Beta tester', research: 'Research cohort',
  unknown: 'Unknown', not_found: 'Account not found', created: 'Account created', confirmation_pending: 'Confirmation pending', confirmed: 'Confirmed', disabled: 'Disabled or deleted',
  not_started: 'Not started', first_plan_generated: 'First plan generated', first_plan_accepted: 'First plan accepted', first_activity_completed: 'First activity completed', repeat_use_observed: 'Repeat use observed', survey_submitted: 'Survey submitted', pilot_completed: 'Pilot completed',
  not_sent: 'Not sent', queued: 'Queued', smtp_accepted: 'Email accepted by mail server', delivery_confirmed: 'Delivery confirmed', bounced: 'Bounced', failed: 'Failed', uncertain: 'Uncertain', opted_out: 'Opted out',
  identified: 'Identified', contacted: 'Contacted', meeting_scheduled: 'Meeting scheduled', in_conversation: 'In conversation', paused: 'Paused', closed: 'Closed',
  approved: 'Approved', pending_review: 'Pending review', draft: 'Draft', retired: 'Retired',
  open: 'Open', done: 'Done', cancelled: 'Cancelled',
  netlify_forms_export: 'Netlify form export', app_identity_export: 'App account export', founder_records: 'Your own records',
  pending: 'Waiting', changes_requested: 'Changes requested', withdrawn: 'Withdrawn', incomplete: 'Incomplete', field_report: 'Field report',
  idea: 'Idea', in_review: 'In review', scheduled: 'Scheduled', published: 'Posted',
  planned: 'Planned', active: 'Active', completed: 'Completed', invited: 'Invited', consented: 'Consented',
  document: 'Doc', content_post: 'Social post', message: 'Message', offer: 'Offer', survey: 'Questionnaire',
  initial: 'First session', follow_up: 'Follow-up session', interview: 'Interview',
  'campus-groups': 'Campus groups/offices', fbgroups: 'Facebook groups', direct: 'Direct', lindsey: 'Lindsey (personal)', campus: 'Campus flyer/QR', other: 'Other',
  instagram: 'Instagram', facebook: 'Facebook page', tiktok: 'TikTok',
};
const L = v => LABEL[v] || v || '—';
const select = (name, options, value, attrs = {}) => h('select', { name, ...attrs }, options.map(o => h('option', { value: o, selected: o === value }, L(o))));
const fmtDate = s => s ? new Date(s.length === 10 ? s + 'T12:00:00' : s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const can = p => ME?.permissions?.includes(p);
const formData = form => Object.fromEntries([...new FormData(form).entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
function errorBox(e) { return h('div', { class: 'notice err', role: 'alert' }, e.message || String(e)); }
async function submitting(form, fn) {
  const btn = form.querySelector('button[type=submit]'); if (btn) btn.disabled = true;
  form.querySelectorAll('.notice.err').forEach(n => n.remove());
  try { await fn(); } catch (e) { form.prepend(errorBox(e)); } finally { if (btn) btn.disabled = false; }
}

// ---------- sign-in screens ----------
function loginScreen(message) {
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => {
    const r = await api('POST', 'auth/request', formData(form));
    clear(form).append(h('div', { class: 'notice' }, r.message), h('p', { class: 'muted' }, 'Open the email on this device and tap the link. It works once and expires in 15 minutes.'));
  }); } },
    h('label', {}, 'Work email', h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, maxlength: 120 })),
    h('button', { class: 'btn', type: 'submit' }, 'Email me a sign-in link'));
  const preview = h('div');
  api('GET', 'auth/me').catch(e => { if (location.hostname.endsWith('.netlify.app')) preview.append(h('p', { class: 'muted' }, 'Preview deploy:'), h('button', { class: 'btn ghost', onclick: async () => { try { const r = await api('POST', 'auth/preview'); r.mfa === 'pending' ? mfaScreen() : boot(); } catch (err) { preview.append(errorBox(err)); } } }, 'Sign in with my Netlify team login')); });
  clear(app).append(h('div', { class: 'center' }, h('div', { class: 'login' },
    h('p', {}, h('span', { class: 'logo' }, 'Spin', h('em', {}, 'Family'), h('small', {}, 'Operations'))),
    h('div', { class: 'card' }, h('h1', {}, 'Team sign-in'), h('p', { class: 'sub' }, 'For the SpinFamily team only. Access is by invitation.'), message ? h('div', { class: 'notice warn' }, message) : null, form, preview))));
}

function mfaScreen(message) {
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'auth/mfa', formData(form)); boot(); }); } },
    h('label', {}, 'Authenticator code', h('span', { class: 'hint' }, 'The 6-digit code from your authenticator app'), h('input', { name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: 6, required: true })),
    h('button', { class: 'btn', type: 'submit' }, 'Continue'));
  const recover = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(recover, async () => { await api('POST', 'auth/authenticator/recover', formData(recover)); toast('Authenticator reset. Set up the new one now.'); boot('#/team'); }); } },
    h('p', { class: 'muted' }, 'Founder only. Enter the setup code saved in Netlify (OPS_FOUNDER_ENROLLMENT_CODE) to reset your authenticator. Teammates: ask Dion to reset yours.'),
    h('label', {}, 'Netlify setup code', h('input', { name: 'enrollmentCode', type: 'password', autocomplete: 'off', required: true })), h('button', { class: 'btn ghost', type: 'submit' }, 'Reset my authenticator'));
  clear(app).append(h('div', { class: 'center' }, h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', {}, 'One more step'), message ? h('div', { class: 'notice warn' }, message) : null, form, h('details', {}, h('summary', {}, 'Lost your phone?'), recover)))));
  form.querySelector('input').focus();
}

async function consumeSignInLink() {
  const m = location.hash.match(/^#signin=([\w-]{20,100})$/);
  if (!m) return false;
  history.replaceState(null, '', '/operations/');
  // A button press, not an automatic request, so email link scanners can't use up the link.
  await new Promise(resolve => {
    clear(app).append(h('div', { class: 'center' }, h('div', { class: 'login' }, h('div', { class: 'card' },
      h('h1', {}, 'Finish signing in'), h('p', { class: 'sub' }, 'Tap below to sign in on this device.'),
      h('button', { class: 'btn', onclick: async ev => { ev.target.disabled = true; try { const r = await api('POST', 'auth/verify', { token: m[1] }); resolve(); r.mfa === 'pending' ? mfaScreen() : boot(); } catch (e) { resolve(); loginScreen(e.message); } } }, 'Sign in')))));
  });
  return true;
}

// ---------- layout ----------
const NAV = [
  ['dashboard', 'Today', 'dashboard.view'], ['approvals', 'Approvals', 'approvals.submit'], ['participants', 'Participants', 'participants.view.assigned'], ['followups', 'Follow-ups', 'followups.manage'],
  ['content', 'Social calendar', 'content.edit'], ['research', 'Research & testing', 'research.view'],
  ['outreach', 'Outreach log', 'outreach.record'], ['relationships', 'Relationships', 'relationships.record'], ['docs', 'Company docs', 'resources.view'], ['team', 'Team & security', null],
];
function layout(active, ...content) {
  const nav = h('nav', { class: 'side', 'aria-label': 'Workspace' }, NAV.filter(([, , p]) => !p || can(p)).map(([id, label]) => h('a', { href: '#/' + id, 'aria-current': active === id ? 'page' : null, onclick: () => nav.classList.remove('open') }, label)));
  clear(app).append(
    h('header', { class: 'top' },
      h('div', { class: 'row' }, h('button', { class: 'btn ghost small menu', 'aria-label': 'Menu', onclick: () => nav.classList.toggle('open') }, 'Menu'), h('a', { class: 'logo', href: '#/dashboard' }, 'Spin', h('em', {}, 'Family'), h('small', {}, 'Ops'))),
      h('div', { class: 'who' }, h('b', {}, ME.member.name), ' · ', ME.member.roleLabel, h('br'), h('span', { class: 'email' }, ME.member.email + ' · '), h('a', { href: '#', onclick: async e => { e.preventDefault(); await api('POST', 'auth/logout').catch(() => {}); ME = null; loginScreen('You are signed out.'); } }, 'Sign out'))),
    h('div', { class: 'shell' }, nav, h('main', { id: 'main', tabindex: '-1' },
      ME.previewDeploy ? h('div', { class: 'notice warn' }, 'Preview deploy: test data only. Nothing here is the real participant list.') : null,
      ME.needsAuthenticator ? h('div', { class: 'notice warn' }, 'Set up your authenticator app below before you can see participant details or anything else in the workspace.') : null,
      ...content)));
}

// ---------- views ----------
async function viewDashboard() {
  const d = await api('GET', 'dashboard');
  layout('dashboard',
    h('h1', {}, 'Today'), h('p', { class: 'sub' }, d.scope === 'all' ? 'All pilot records.' : 'Your assigned participants and the shared outreach records.'),
    h('div', { class: 'grid' }, d.metrics.map(m => h('div', { class: 'card kpi' }, h('span', { class: 'tag ' + m.status }, m.status), h('div', { class: 'v' }, m.value === null ? 'Unknown' : m.value), h('div', { class: 'l' }, m.label), h('p', {}, m.definition), h('p', {}, 'Source: ' + m.source)))),
    h('h2', {}, 'Follow-ups due in the next 2 weeks'),
    d.dueFollowups.length ? h('ul', {}, d.dueFollowups.map(f => h('li', {}, f.title, ' — ', h('span', { class: 'muted' }, f.dueDate ? fmtDate(f.dueDate) : 'no date')))) : h('p', { class: 'muted' }, 'Nothing due. ', h('a', { href: '#/followups' }, 'Add a follow-up')),
    h('h2', {}, 'Upcoming conversations'),
    d.upcoming.length ? h('ul', {}, d.upcoming.map(r => h('li', {}, h('a', { href: '#/relationships/' + r.id }, r.contactName), ` (${r.organization}): ${r.nextAction || 'next step'} — ${fmtDate(r.nextActionDate)}`))) : h('p', { class: 'muted' }, 'None scheduled in the next 2 weeks.'),
    h('h2', {}, 'Recent pilot form registrations'),
    d.recentRegistrations.length ? h('ul', {}, d.recentRegistrations.map(p => h('li', {}, h('a', { href: '#/participants/' + p.id }, p.firstName), ` — ${fmtDate(p.createdAt)}, link source: ${L(p.technicalSource)}`))) : h('p', { class: 'muted' }, 'None received through the form since this workspace went live.'),
    h('h2', {}, 'Where people came from'),
    h('div', { class: 'grid' },
      breakdown('Link source (from the sign-up form)', d.breakdowns.technicalSource),
      breakdown('Reported by the team', d.breakdowns.reportedSource),
      breakdown('App account', d.breakdowns.account),
      breakdown('Engagement', d.breakdowns.engagement)));
}
function breakdown(title, obj) {
  const rows = Object.entries(obj || {});
  return h('div', { class: 'card' }, h('div', { class: 'l', style: null }, h('b', {}, title)), rows.length ? h('ul', {}, rows.map(([k, v]) => h('li', {}, `${L(k)}: ${v}`))) : h('p', { class: 'muted' }, 'No records yet.'));
}

async function viewParticipants() {
  const d = await api('GET', 'participants');
  const form = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'participants', formData(form)); toast('Participant added'); viewParticipants(); }); } },
    h('label', {}, 'First name', h('input', { name: 'firstName', required: true, maxlength: 60 })),
    h('label', {}, 'Email (optional)', h('input', { name: 'email', type: 'email', maxlength: 120 })),
    h('label', {}, 'Cohort', select('cohort', d.states.cohort, 'prospect')),
    h('label', {}, 'How they heard (team report)', select('reportedSource', d.refs, 'unknown')),
    h('label', { style: null }, 'Notes', h('input', { name: 'notes', maxlength: 1000 })),
    h('button', { class: 'btn', type: 'submit' }, 'Add'));
  layout('participants',
    h('h1', {}, 'Participants'), h('p', { class: 'sub' }, d.scope === 'all' ? 'Everyone in the pilot workspace.' : 'Participants assigned to you. Ask Dion to assign anyone you are helping.'),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Cohort', 'Enrollment', 'App account', 'Engagement', 'Added'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.participants.length ? d.participants.map(p => h('tr', {},
        h('td', {}, h('a', { href: '#/participants/' + p.id }, p.firstName), p.isTest === true ? h('span', { class: 'tag' }, ' test') : p.isTest === null ? h('span', { class: 'tag pending' }, ' not reviewed') : null),
        h('td', {}, p.email || '—'), h('td', {}, L(p.cohort)), h('td', {}, L(p.enrollment)), h('td', {}, L(p.account)), h('td', {}, L(p.engagement)), h('td', {}, fmtDate(p.createdAt)))) : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No participants yet.'))))),
    h('h2', {}, 'Add a participant'), h('p', { class: 'muted' }, 'Adults only. Never record children\'s names, birthdays, schools, photos or health details.'), form,
    can('participants.verify') ? importPanel() : null);
}
function importPanel() {
  const f = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(f, async () => {
    const b = formData(f);
    const records = b.rows.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [firstName, email, source, submittedAt] = l.split(',').map(x => (x || '').trim()); return { firstName, email, source: source || undefined, submittedAt: submittedAt || undefined }; });
    const r = await api('POST', 'participants/import', { source: b.source, exportedAt: b.exportedAt, records, markBackfillComplete: !!f.querySelector('input[name=done]:checked') });
    toast(`Imported ${r.created}. ${r.alreadyExisted} already existed.`); viewParticipants();
  }); } },
    h('label', {}, 'Where this list came from', select('source', ['netlify_forms_export', 'app_identity_export', 'founder_records'], 'netlify_forms_export')),
    h('label', {}, 'Date you exported it', h('input', { name: 'exportedAt', type: 'date', required: true })),
    h('label', {}, 'One person per line: first name, email, link source (optional), submitted date (optional)', h('textarea', { name: 'rows', required: true, placeholder: 'Jordan, jordan@example.com, direct, 2026-11-12' })),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'done' }), 'This finishes the backfill (the dashboard stops saying counts are incomplete)'),
    h('button', { class: 'btn', type: 'submit' }, 'Import'));
  return h('details', {}, h('summary', {}, 'Import earlier sign-ups or beta testers'), h('p', { class: 'muted' }, 'Imported people are marked "not reviewed" until you confirm they are real participants. Existing emails are skipped.'), f);
}

async function viewParticipant(id) {
  const [d, team] = await Promise.all([api('GET', 'participants/' + id), can('team.manage') ? api('GET', 'team').catch(() => null) : null]);
  const p = d.participant;
  const founder = can('participants.verify');
  const states = { enrollment: ['prospect', 'registration_received', 'eligibility_confirmed', 'enrolled', 'withdrawn', 'archived'], account: ['unknown', 'not_found', 'created', 'confirmation_pending', 'confirmed', 'disabled'], engagement: ['unknown', 'not_started', 'first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed', 'survey_submitted', 'pilot_completed'], communication: ['unknown', 'not_sent', 'queued', 'smtp_accepted', 'delivery_confirmed', 'bounced', 'failed', 'uncertain', 'opted_out'] };
  const label = { enrollment: 'Enrollment', account: 'App account', engagement: 'Engagement', communication: 'Pilot emails' };
  const badge = f => f in p.verified ? h('span', { class: 'tag ' + (p.verified[f] ? 'approved' : 'pending') }, p.verified[f] ? 'verified' : 'reported') : null;
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => {
    const body = formData(form);
    body.version = p.version;
    if ('isTest' in body) body.isTest = body.isTest === 'yes';
    if (body.assignedTo === '') body.assignedTo = null;
    if (founder) { body.verify = {}; for (const f of ['account', 'engagement', 'communication']) if (form.querySelector(`input[name=verify_${f}]`)?.checked) body.verify[f] = true; for (const f of ['account', 'engagement', 'communication']) delete body['verify_' + f]; }
    try { await api('PATCH', 'participants/' + id, body); toast('Saved'); viewParticipant(id); }
    catch (err) { if (err.status === 409) { toast('Someone else changed this. Showing the latest.'); viewParticipant(id); return; } throw err; }
  }); } },
    founder ? h('label', {}, 'Cohort', select('cohort', ['pilot', 'beta', 'research', 'prospect'], p.cohort)) : h('p', {}, h('b', {}, 'Cohort: '), L(p.cohort)),
    ...Object.entries(states).map(([f, list]) => h('label', {}, h('span', { class: 'row' }, label[f], badge(f)), select(f, list, p[f]),
      founder && f !== 'enrollment' ? h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'verify_' + f, checked: p.verified[f] }), 'I checked this against a source') : null)),
    founder ? h('label', {}, 'How you checked (needed when you tick a box above)', h('input', { name: 'evidenceNote', maxlength: 300, placeholder: 'e.g. Checked Netlify Identity on Nov 26' })) : h('p', { class: 'muted' }, 'Your updates are saved as reported. Dion marks them verified once he checks them against the app or mailbox.'),
    h('label', {}, 'How they heard (team report)', select('reportedSource', ['instagram', 'facebook', 'fbgroups', 'tiktok', 'lindsey', 'campus', 'campus-groups', 'direct', 'other', 'unknown'], p.reportedSource)),
    team ? h('label', {}, 'Assigned to', h('select', { name: 'assignedTo' }, h('option', { value: '' }, 'Nobody'), team.members.filter(m => m.status !== 'revoked').map(m => h('option', { value: m.id, selected: m.id === p.assignedTo }, m.name)))) : null,
    can('participants.markTest') ? h('label', {}, 'Internal test entry?', h('select', { name: 'isTest' }, h('option', { value: 'no', selected: p.isTest === false }, 'No, a real participant'), h('option', { value: 'yes', selected: p.isTest === true }, 'Yes, exclude from counts'))) : null,
    h('label', {}, 'Notes', h('span', { class: 'hint' }, 'Adults only. No children\'s names, schools, health or other sensitive details.'), h('textarea', { name: 'notes', maxlength: 1000 }, p.notes || '')),
    h('button', { class: 'btn', type: 'submit' }, 'Save changes'));
  layout('participants',
    h('p', {}, h('a', { href: '#/participants' }, '← Participants')),
    h('h1', {}, p.firstName), h('p', { class: 'sub' }, p.email || 'No email on file', p.emailMasked ? ' (hidden: not assigned to you)' : ''),
    h('div', { class: 'card' },
      h('p', {}, h('b', {}, 'Link source from the sign-up form: '), p.technicalSource ? L(p.technicalSource) : 'Not from the form'),
      p.heardFrom ? h('p', {}, h('b', {}, 'They said they heard about it from: '), p.heardFrom) : null,
      h('p', { class: 'muted' }, 'Form sources are kept as recorded. Use "How they heard" for what the team reports.'),
      p.intake?.receivedAt ? h('p', {}, h('b', {}, 'Form received: '), fmtDate(p.intake.receivedAt)) : null,
      p.intake?.importedFrom ? h('p', {}, h('b', {}, 'Imported from: '), `${p.intake.importedFrom.replace(/_/g, ' ')} (exported ${fmtDate(p.intake.exportedAt)})`) : null),
    p.isTest === null && can('participants.markTest') ? h('div', { class: 'notice warn' }, 'This registration hasn\'t been reviewed yet. Mark whether it is an internal test.') : null,
    h('h2', {}, 'Status'), form,
    h('h2', {}, 'History'), h('p', { class: 'muted' }, 'Every change is recorded and can\'t be edited.'),
    d.history.length ? h('ul', {}, d.history.map(x => h('li', {}, `${fmtDate(x.at)}: `, x.changes.map(c => `${c.field} ${c.from !== undefined && c.from !== null ? L(c.from) + ' → ' : ''}${L(c.to)}`).join('; ')))) : h('p', { class: 'muted' }, 'No changes yet.'));
}

async function viewFollowups() {
  const [d, ps] = await Promise.all([api('GET', 'followups'), api('GET', 'participants')]);
  const names = Object.fromEntries(ps.participants.map(p => [p.id, p.firstName]));
  const form = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(form, async () => {
    const b = formData(form); if (b.subjectId) b.subjectType = 'participant'; else { b.subjectType = 'general'; delete b.subjectId; }
    await api('POST', 'followups', b); toast('Follow-up added'); viewFollowups(); }); } },
    h('label', {}, 'What needs to happen', h('input', { name: 'title', required: true, maxlength: 200 })),
    h('label', {}, 'About (optional)', h('select', { name: 'subjectId' }, h('option', { value: '' }, 'General'), ps.participants.map(p => h('option', { value: p.id }, p.firstName)))),
    h('label', {}, 'Due', h('input', { name: 'dueDate', type: 'date' })),
    h('button', { class: 'btn', type: 'submit' }, 'Add'));
  const today = new Date().toISOString().slice(0, 10);
  layout('followups', h('h1', {}, 'Follow-ups'), h('p', { class: 'sub' }, 'Things someone promised to do next.'), form, h('h2', {}, 'Open'),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['What', 'About', 'Due', ''].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.followups.filter(f => f.status === 'open').map(f => h('tr', {}, h('td', {}, f.title), h('td', {}, f.subjectId ? (names[f.subjectId] || 'Record') : 'General'),
        h('td', {}, f.dueDate ? fmtDate(f.dueDate) : '—', f.dueDate && f.dueDate < today ? h('span', { class: 'tag pending' }, ' overdue') : null),
        h('td', {}, h('button', { class: 'btn small ghost', onclick: async () => { const outcome = prompt('What happened? (optional)') ?? ''; await api('PATCH', 'followups/' + f.id, { status: 'done', outcome }); toast('Marked done'); viewFollowups(); } }, 'Done'))))))),
    h('details', {}, h('summary', {}, 'Completed'), h('ul', {}, d.followups.filter(f => f.status !== 'open').map(f => h('li', {}, `${f.title} — ${L(f.status)}${f.outcome ? ': ' + f.outcome : ''}`)))));
}

async function viewOutreach() {
  const d = await api('GET', 'outreach');
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'outreach', formData(form)); toast('Outreach logged'); viewOutreach(); }); } },
    h('div', { class: 'row' }, h('label', {}, 'Date', h('input', { name: 'date', type: 'date', value: new Date().toISOString().slice(0, 10) })), h('label', {}, 'Channel', select('channel', d.refs, 'campus'))),
    h('label', {}, 'Organization or event', h('input', { name: 'place', required: true, maxlength: 120 })),
    h('div', { class: 'row' }, h('label', {}, 'People approached', h('span', { class: 'hint' }, 'Leave blank if unknown'), h('input', { name: 'approached', type: 'number', min: 0 })), h('label', {}, 'Demos shown', h('input', { name: 'demos', type: 'number', min: 0 })), h('label', {}, 'Sign-ups you saw', h('input', { name: 'reportedSignups', type: 'number', min: 0 }))),
    h('label', {}, 'Follow-ups you promised', h('textarea', { name: 'followUpCommitments', maxlength: 500 })),
    h('label', {}, 'What you noticed', h('textarea', { name: 'observations', maxlength: 1000 })),
    h('label', {}, 'Anything blocking you', h('textarea', { name: 'blockers', maxlength: 500 })),
    h('button', { class: 'btn', type: 'submit' }, 'Log outreach'));
  layout('outreach', h('h1', {}, 'Outreach log'), h('p', { class: 'sub' }, 'Your field reports. Sign-ups you saw are kept separate from verified registrations.'),
    h('details', {}, h('summary', {}, 'Log a new outreach session'), form),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Date', 'Where', 'Channel', 'Approached', 'Demos', 'Sign-ups seen', 'Notes'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.outreach.length ? d.outreach.map(o => h('tr', {}, h('td', {}, fmtDate(o.date)), h('td', {}, o.place), h('td', {}, L(o.channel)), h('td', {}, o.approached ?? 'Unknown'), h('td', {}, o.demos ?? 'Unknown'), h('td', {}, o.reportedSignups ?? 'Unknown'), h('td', {}, [o.observations, o.blockers && 'Blocker: ' + o.blockers].filter(Boolean).join(' · ') || '—'))) : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'Nothing logged yet.'))))));
}

async function viewRelationships() {
  const d = await api('GET', 'relationships');
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'relationships', formData(form)); toast('Relationship added'); viewRelationships(); }); } },
    h('div', { class: 'row' }, h('label', {}, 'Contact name', h('input', { name: 'contactName', required: true, maxlength: 80 })), h('label', {}, 'Organization', h('input', { name: 'organization', required: true, maxlength: 120, value: 'Cincinnati State' }))),
    h('label', {}, 'Office or function', h('input', { name: 'office', maxlength: 120 })),
    h('div', { class: 'row' }, h('label', {}, 'Stage', select('stage', d.stages, 'identified')), h('label', {}, 'Next action date', h('input', { name: 'nextActionDate', type: 'date' }))),
    h('label', {}, 'Next action', h('input', { name: 'nextAction', maxlength: 200 })),
    h('label', {}, 'Notes', h('textarea', { name: 'notes', maxlength: 1000 })),
    h('button', { class: 'btn', type: 'submit' }, 'Add relationship'));
  layout('relationships', h('h1', {}, 'Relationships'), h('p', { class: 'sub' }, 'Offices and people we\'re getting to know. None of these is a partnership or agreement until Dion approves one.'),
    h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Contact', 'Organization', 'Stage', 'Next action', 'When'].map(t => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, d.relationships.length ? d.relationships.map(r => h('tr', {}, h('td', {}, h('a', { href: '#/relationships/' + r.id }, r.contactName)), h('td', {}, r.organization, r.office ? ` · ${r.office}` : ''), h('td', {}, L(r.stage)), h('td', {}, r.nextAction || '—'), h('td', {}, fmtDate(r.nextActionDate)))) : h('tr', {}, h('td', { colspan: 5, class: 'muted' }, 'None yet.'))))),
    h('details', {}, h('summary', {}, 'Add a relationship'), form));
}

async function viewRelationship(id) {
  const d = await api('GET', 'relationships');
  const r = d.relationships.find(x => x.id === id); if (!r) throw new Error('Not found.');
  const founder = ME.member.role === 'founder';
  const canEdit = founder || r.createdBy === ME.member.id || r.owner === ME.member.id;
  const edit = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(edit, async () => {
    try { await api('PATCH', 'relationships/' + id, { ...formData(edit), version: r.version }); toast('Saved'); viewRelationship(id); }
    catch (err) { if (err.status === 409) { toast('Someone else changed this. Showing the latest.'); viewRelationship(id); return; } throw err; }
  }); } },
    h('div', { class: 'row' }, h('label', {}, 'Stage', select('stage', d.stages, r.stage)), h('label', {}, 'Next action date', h('input', { name: 'nextActionDate', type: 'date', value: r.nextActionDate || '' }))),
    h('label', {}, 'Next action', h('input', { name: 'nextAction', maxlength: 200, value: r.nextAction || '' })),
    h('label', {}, 'Notes', h('textarea', { name: 'notes', maxlength: 1000 }, r.notes || '')),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));
  const log = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(log, async () => { await api('POST', `relationships/${id}/log`, formData(log)); toast('Logged'); viewRelationship(id); }); } },
    h('label', {}, 'Type', select('kind', ['meeting', 'demo', 'call', 'email', 'note'], 'meeting')), h('label', {}, 'What happened', h('input', { name: 'summary', required: true, maxlength: 500 })), h('button', { class: 'btn', type: 'submit' }, 'Add'));
  const offer = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(offer, async () => { await api('POST', 'approvals', { itemType: 'offer', relationshipId: id, offer: formData(offer).offer }); toast('Sent to Dion for approval'); viewRelationship(id); }); } },
    h('label', {}, 'What would you like to offer or promise?', h('textarea', { name: 'offer', required: true, maxlength: 1000, placeholder: 'e.g. A demo table at the Parenting Resource Center in December' })), h('button', { class: 'btn', type: 'submit' }, 'Ask Dion to approve'));
  layout('relationships', h('p', {}, h('a', { href: '#/relationships' }, '← Relationships')), h('h1', {}, r.contactName), h('p', { class: 'sub' }, `${r.organization}${r.office ? ' · ' + r.office : ''}`),
    h('div', { class: 'notice' }, r.offerApproved ? 'Dion has approved making offers to this contact.' : 'No offers approved yet. Share approved materials only, and check with Dion before promising anything.',
      founder ? h('div', { class: 'row' }, h('button', { class: 'btn small ghost', onclick: async () => { await api('PATCH', 'relationships/' + id, { offerApproved: !r.offerApproved }); viewRelationship(id); } }, r.offerApproved ? 'Withdraw offer approval' : 'Approve offers')) : null),
    canEdit ? edit : h('p', { class: 'muted' }, 'Dion or the person who added this contact can edit it. You can still log your contact below.'),
    !founder ? h('details', {}, h('summary', {}, 'Ask to make an offer'), offer) : null,
    h('h2', {}, 'Contact log'), log, (r.log || []).length ? h('ul', {}, [...r.log].reverse().map(x => h('li', {}, `${fmtDate(x.at)} · ${x.kind}: ${x.summary}`))) : h('p', { class: 'muted' }, 'Nothing logged yet.'));
}

const fmtSize = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const CAT = { outreach: 'Outreach', brand: 'Brand', research: 'Research', training: 'Training', policy: 'Policies', meeting: 'Meetings', other: 'Other' };
function readBase64(file) {
  return new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = () => reject(new Error('Could not read that file.')); fr.readAsDataURL(file); });
}
function audienceLabel(r, members) {
  const a = r.audience || 'team';
  if (a === 'team') return 'Whole team';
  if (a === 'founder') return 'Dion only';
  return 'Shared with: ' + a.map(id => members[id] || 'former member').join(', ');
}

async function viewResources() {
  const manage = can('resources.manage');
  const [d, team] = await Promise.all([api('GET', 'resources'), manage ? api('GET', 'team').catch(() => null) : null]);
  const members = Object.fromEntries((team?.members || []).map(m => [m.id, m.name]));
  const others = (team?.members || []).filter(m => m.status !== 'revoked' && m.id !== ME.member.id);

  // Upload form
  const audienceBox = manage ? h('fieldset', { class: 'card' }, h('legend', {}, 'Who can see it'),
    h('label', { class: 'row' }, h('input', { type: 'radio', name: 'audienceMode', value: 'team', checked: true }), 'Whole team'),
    h('label', { class: 'row' }, h('input', { type: 'radio', name: 'audienceMode', value: 'some' }), 'Only these people:'),
    others.map(m => h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'audienceMember', value: m.id }), m.name)),
    h('label', { class: 'row' }, h('input', { type: 'radio', name: 'audienceMode', value: 'founder' }), 'Just me for now')) : h('p', { class: 'muted' }, 'Your upload goes to Dion to review. He decides who else sees it.');
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => {
    const file = form.querySelector('input[type=file]').files[0];
    if (!file) throw new Error('Choose a file first.');
    if (file.size > d.maxFileBytes) throw new Error('That file is over 4 MB. Compress it or add a Drive link instead.');
    const f = formData(form);
    const body = { title: f.title || file.name.replace(/\.[^.]+$/, ''), intendedUse: f.intendedUse, category: f.category, fileName: file.name, dataBase64: await readBase64(file) };
    if (manage) {
      const mode = form.querySelector('input[name=audienceMode]:checked').value;
      body.audience = mode === 'some' ? [...form.querySelectorAll('input[name=audienceMember]:checked')].map(x => x.value) : mode;
      if (mode === 'some' && !body.audience.length) throw new Error('Pick at least one person, or choose Whole team.');
      body.approval = f.approval; body.notify = !!form.querySelector('input[name=notify]:checked');
    }
    const r = await api('POST', 'resources/upload', body);
    toast(r.notified ? `Uploaded. ${r.notified} ${r.notified === 1 ? 'person was' : 'people were'} emailed.` : 'Uploaded');
    viewResources();
  }); } },
    h('label', {}, 'File', h('span', { class: 'hint' }, 'PDF, Word, Excel, PowerPoint, PNG, JPG or WebP. Up to 4 MB.'), h('input', { type: 'file', accept: '.pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.webp', required: true })),
    h('label', {}, 'Title', h('input', { name: 'title', maxlength: 120, placeholder: 'Uses the file name if left blank' })),
    h('label', {}, 'What it\'s for', h('input', { name: 'intendedUse', maxlength: 300, placeholder: 'e.g. Hand to Denise at the Parenting Resource Center' })),
    h('label', {}, 'Category', select('category', d.categories, 'outreach')),
    manage ? h('label', {}, 'Approval', h('span', { class: 'hint' }, 'Approved means OK to share outside the team.'), select('approval', d.approvals.filter(a => a !== 'retired'), 'approved')) : null,
    audienceBox,
    manage ? h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'notify', checked: true }), 'Email the people it\'s shared with') : null,
    h('button', { class: 'btn', type: 'submit' }, 'Upload'));

  const card = r => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'tag ' + r.approval }, L(r.approval)), h('span', { class: 'tag' }, CAT[r.category] || 'Other'), r.kind === 'file' ? h('span', { class: 'tag' }, (r.fileName.split('.').pop() || '').toUpperCase() + ' · ' + fmtSize(r.size)) : h('span', { class: 'tag' }, 'Link')),
    h('h3', {}, r.kind === 'file' ? h('a', { href: `/operations/api/resources/${r.id}/file` }, r.title) : h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title)),
    r.intendedUse ? h('p', { class: 'muted' }, r.intendedUse) : null,
    h('p', { class: 'muted' }, [r.uploadedByName ? `Added by ${r.uploadedByName}` : null, r.createdAt ? fmtDate(r.createdAt) : null, manage ? audienceLabel(r, members) : null].filter(Boolean).join(' · ')),
    r.kind === 'link' && !manage ? h('p', { class: 'muted' }, 'Opens in Google Drive. Ask Dion if it says you need access.') : null,
    manage ? h('div', { class: 'row' },
      select('approval', d.approvals, r.approval, { 'aria-label': 'Approval for ' + r.title, onchange: async e => { await api('PATCH', 'resources/' + r.id, { approval: e.target.value }); toast('Updated'); viewResources(); } }),
      h('select', { 'aria-label': 'Who can see ' + r.title, onchange: async e => { const v = e.target.value; const audience = v.startsWith('m:') ? [v.slice(2)] : v; const res = await api('PATCH', 'resources/' + r.id, { audience, notify: true }); toast(res.notified ? 'Shared and emailed' : 'Updated'); viewResources(); } },
        h('option', { value: '', selected: true, disabled: true }, 'Share with…'), h('option', { value: 'team' }, 'Whole team'), h('option', { value: 'founder' }, 'Just me'), others.map(m => h('option', { value: 'm:' + m.id }, 'Only ' + m.name)))) : null);

  const pending = manage ? d.resources.filter(r => r.approval === 'pending_review' && r.uploadedBy && r.uploadedBy !== ME.member.id) : [];
  const groups = {};
  for (const r of d.resources) (groups[r.category || 'other'] ||= []).push(r);
  layout('docs', h('h1', {}, 'Company docs'),
    h('p', { class: 'sub' }, manage ? 'Upload files and choose who on the team sees them. Use approved docs as-is outside the team; anything pending needs your OK first.' : 'Docs Dion has shared with you. Approved ones are OK to share outside the team; anything pending review needs Dion\'s OK first.'),
    pending.length ? h('div', { class: 'notice warn' }, `${pending.length} upload${pending.length > 1 ? 's' : ''} from the team waiting for your review.`) : null,
    h('details', { open: d.resources.length === 0 }, h('summary', {}, manage ? 'Upload a doc' : 'Send Dion a doc'), form),
    d.resources.length ? h('div', {}, Object.keys(CAT).filter(c => groups[c]).flatMap(c => [h('h2', {}, CAT[c]), h('div', { class: 'grid' }, groups[c].map(card))])) : h('p', { class: 'muted' }, 'Nothing shared yet.'));
}

async function viewTeam() {
  const parts = [h('h1', {}, 'Team & security')];
  const sec = h('div', { class: 'card' });
  if (ME.needsAuthenticator) {
    const founder = ME.founderEnrollmentCodeRequired;
    sec.append(h('h2', {}, 'Set up your authenticator app'), h('p', {}, 'Everyone on the team uses a second step: a 6-digit code from an app like Google Authenticator, Microsoft Authenticator or 1Password. It protects parents\' details if someone gets into your email.'));
    const startForm = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(startForm, async () => {
      const s = await api('POST', 'auth/authenticator/setup', founder ? formData(startForm) : {});
      const f = h('form', { class: 'stack', onsubmit: ev => { ev.preventDefault(); submitting(f, async () => { await api('POST', 'auth/authenticator/confirm', formData(f)); toast('Authenticator turned on'); boot('#/dashboard'); }); } },
        h('p', {}, '1. In your authenticator app, add an account and choose "Enter a setup key". Use this key (time-based):'), h('p', { class: 'mono' }, s.secret.replace(/(.{4})/g, '$1 ').trim()),
        h('p', {}, h('a', { href: s.uri }, 'Or tap here on your phone to add it directly')),
        h('label', {}, '2. Enter the 6-digit code it shows', h('input', { name: 'code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, required: true, autocomplete: 'one-time-code' })),
        h('button', { class: 'btn', type: 'submit' }, 'Turn on'));
      clear(sec).append(h('h2', {}, 'Set up your authenticator app'), f);
    }); } },
      founder ? h('label', {}, 'Netlify setup code', h('span', { class: 'hint' }, 'The value of OPS_FOUNDER_ENROLLMENT_CODE in Netlify → Project configuration → Environment variables. It proves you control the hosting account.'), h('input', { name: 'enrollmentCode', type: 'password', autocomplete: 'off', required: true })) : null,
      h('button', { class: 'btn', type: 'submit' }, 'Start setup'));
    sec.append(startForm);
  } else sec.append(h('h2', {}, 'Your access'), h('p', {}, `${ME.member.roleLabel}. Sign-in links go to ${ME.member.email}. Authenticator: on.`), ME.member.role !== 'founder' ? h('p', { class: 'muted' }, 'To change your access or reset your authenticator, ask Dion.') : null);
  parts.push(sec);

  if (can('team.manage')) {
    const t = await api('GET', 'team');
    const form = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'team/invite', formData(form)); toast('Added. They can now request a sign-in link.'); viewTeam(); }); } },
      h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80 })), h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, maxlength: 120 })),
      h('label', {}, 'Role', select('role', t.roles.map(r => r.id).filter(r => r !== 'founder'), 'coordinator')), h('label', {}, 'Title', h('input', { name: 'title', maxlength: 80, placeholder: 'Community & Programs Coordinator' })),
      h('button', { class: 'btn', type: 'submit' }, 'Give access'));
    const act = (m, action, label, confirmText) => h('button', { class: 'btn small ghost', onclick: async () => { if (confirmText && !confirm(confirmText)) return; await api('PATCH', 'team/' + m.id, { action }); toast('Done'); viewTeam(); } }, label);
    parts.push(h('h2', {}, 'Team members'),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', 'Authenticator', 'Last sign-in', ''].map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, t.members.map(m => h('tr', {}, h('td', {}, m.name, h('br'), h('span', { class: 'muted' }, m.title)), h('td', {}, m.email), h('td', {}, m.roleLabel), h('td', {}, L(m.status)), h('td', {}, m.mfaEnabled ? 'On' : 'Not set up'), h('td', {}, fmtDate(m.lastSignInAt)),
          h('td', {}, m.id === ME.member.id ? 'You' : h('div', { class: 'row' },
            m.status === 'revoked' ? act(m, 'restore', 'Restore') : act(m, 'revoke', 'Remove access', `Remove ${m.name}'s access? They will be signed out right away.`),
            m.status === 'active' ? act(m, 'sign_out_everywhere', 'Sign out everywhere') : null,
            m.mfaEnabled ? act(m, 'reset_authenticator', 'Reset authenticator', `Reset ${m.name}'s authenticator? They'll set up a new one at their next sign-in.`) : null,
            h('button', { class: 'btn small ghost', onclick: async () => { const email = prompt(`New sign-in email for ${m.name}:`, m.email); if (!email || email === m.email) return; try { await api('PATCH', 'team/' + m.id, { email }); toast('Email changed. Their next sign-in link goes to the new address.'); viewTeam(); } catch (err) { alert(err.message); } } }, 'Change email')))))))),
      h('h2', {}, 'Give someone access'), h('p', { class: 'muted' }, 'They sign in with a link sent to this email and set up an authenticator app. Nobody can sign up on their own.'), form);
    if (can('audit.view')) {
      const a = await api('GET', 'audit');
      parts.push(h('details', {}, h('summary', {}, 'Activity log (last 200)'), h('ul', {}, a.audit.map(x => h('li', {}, `${new Date(x.at).toLocaleString()} · ${x.action}${x.target ? ' · ' + x.target : ''}`)))));
    }
  }
  layout('team', ...parts);
}

// ---------- Approvals ----------
async function viewApprovals() {
  const d = await api('GET', 'approvals');
  const founder = can('approvals.decide');
  const team = founder ? await api('GET', 'team').catch(() => null) : null;
  const others = (team?.members || []).filter(m => m.status !== 'revoked' && m.id !== ME.member.id);
  const card = a => {
    const decide = founder && a.status === 'pending' ? (() => {
      const f = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); } },
        a.itemType === 'document' ? h('label', {}, 'If approved, who sees it', h('select', { name: 'audience' }, h('option', { value: 'team' }, 'Whole team'), h('option', { value: 'founder' }, 'Just me'), others.map(m => h('option', { value: 'm:' + m.id }, 'Only ' + m.name)))) : null,
        h('label', {}, 'Note (needed if you ask for changes)', h('textarea', { name: 'note', maxlength: 1000 })),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => submitting(f, async () => { const b = formData(f); const body = { decision: 'approved', note: b.note }; if (b.audience) body.audience = b.audience.startsWith('m:') ? [b.audience.slice(2)] : b.audience; await api('POST', `approvals/${a.id}/decide`, body); toast('Approved'); viewApprovals(); }) }, 'Approve'),
          h('button', { class: 'btn ghost', type: 'button', onclick: () => submitting(f, async () => { await api('POST', `approvals/${a.id}/decide`, { decision: 'changes_requested', note: formData(f).note }); toast('Sent back with your note'); viewApprovals(); }) }, 'Ask for changes')));
      return f;
    })() : null;
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'tag ' + (a.status === 'pending' ? 'pending' : a.status === 'approved' ? 'approved' : 'draft') }, L(a.status)), h('span', { class: 'tag' }, L(a.itemType))),
      h('h3', {}, a.title), a.summary ? h('p', { class: 'pre' }, a.summary) : null,
      a.payload?.message ? h('p', { class: 'mono' }, a.payload.message) : null,
      a.payload?.channel && a.itemType === 'message' ? h('p', { class: 'muted' }, `Via ${a.payload.channel.replace('_', ' ')} to ${a.payload.to}`) : null,
      h('p', { class: 'muted' }, `From ${a.submittedByName} · ${fmtDate(a.submittedAt)}`),
      a.itemType === 'document' && a.itemId ? h('p', {}, h('a', { href: `/operations/api/resources/${a.itemId}/file` }, 'Download the file to review')) : null,
      a.itemType === 'survey' && a.itemId ? h('p', {}, h('a', { href: `#/research/${a.itemId}` }, 'Read the questions')) : null,
      a.decisionNote ? h('div', { class: 'notice' }, h('b', {}, 'Dion\'s note: '), a.decisionNote) : null,
      decide,
      !founder && ['pending', 'changes_requested'].includes(a.status) ? h('button', { class: 'btn small ghost', onclick: async () => { await api('POST', `approvals/${a.id}/withdraw`); viewApprovals(); } }, 'Withdraw') : null);
  };
  const msg = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(msg, async () => { await api('POST', 'approvals', { itemType: 'message', ...formData(msg) }); toast('Sent to Dion for approval'); viewApprovals(); }); } },
    h('div', { class: 'row' }, h('label', {}, 'Who it goes to', h('input', { name: 'to', required: true, maxlength: 120, placeholder: 'e.g. Denise, Parenting Resources' })), h('label', {}, 'How', select('channel', d.channels, 'email'))),
    h('label', {}, 'Message', h('textarea', { name: 'message', required: true, maxlength: 3000 })), h('button', { class: 'btn', type: 'submit' }, 'Send for approval'));
  const pending = d.approvals.filter(a => a.status === 'pending'), back = d.approvals.filter(a => a.status === 'changes_requested'), rest = d.approvals.filter(a => !['pending', 'changes_requested'].includes(a.status));
  layout('approvals', h('h1', {}, 'Approvals'),
    h('p', { class: 'sub' }, founder ? 'Everything the team wants to share outside the team waits here for your OK.' : 'Anything that goes outside the team gets Dion\'s OK first. Nothing here is sent automatically; once approved, you send it.'),
    !founder ? h('details', {}, h('summary', {}, 'Send a message draft for approval'), msg) : null,
    h('h2', {}, founder ? `Waiting for you (${pending.length})` : `Waiting for Dion (${pending.length})`), pending.length ? h('div', { class: 'grid' }, pending.map(card)) : h('p', { class: 'muted' }, 'Nothing waiting.'),
    back.length ? [h('h2', {}, 'Changes requested'), h('div', { class: 'grid' }, back.map(card))] : null,
    rest.length ? h('details', {}, h('summary', {}, 'Decided'), h('div', { class: 'grid' }, rest.map(card))) : null);
}

// ---------- Social calendar ----------
async function viewContent() {
  const [d, docs] = await Promise.all([api('GET', 'content'), api('GET', 'resources')]);
  const assetSelect = (val) => h('select', { name: 'assetDocumentId' }, h('option', { value: '' }, 'None'), docs.resources.map(r => h('option', { value: r.id, selected: r.id === val }, r.title)));
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'content', formData(form)); toast('Draft saved'); viewContent(); }); } },
    h('div', { class: 'row' }, h('label', {}, 'Channel', select('channel', d.channels, 'instagram')), h('label', {}, 'Planned date', h('input', { name: 'plannedDate', type: 'date' }))),
    h('label', {}, 'Caption', h('span', { class: 'hint' }, 'The tracking link for the channel is added for you.'), h('textarea', { name: 'caption', maxlength: 2200 })),
    h('label', {}, 'Graphic or file (from Company docs)', assetSelect('')),
    h('label', {}, 'Notes', h('input', { name: 'notes', maxlength: 1000 })),
    h('button', { class: 'btn', type: 'submit' }, 'Save draft'));
  const actions = p => {
    const mine = p.createdBy === ME.member.id || ME.member.role === 'founder';
    const b = [];
    if (mine && ['draft', 'changes_requested'].includes(p.status)) b.push(h('button', { class: 'btn small', onclick: async () => { try { await api('POST', `content/${p.id}/submit`); toast('Sent for approval'); viewContent(); } catch (e) { alert(e.message); } } }, 'Send for approval'));
    if (['approved', 'scheduled'].includes(p.status)) b.push(h('button', { class: 'btn small', onclick: async () => { const u = prompt('Link to the live post (optional):') ?? ''; try { await api('POST', `content/${p.id}/published`, { publishedUrl: u }); toast('Marked as posted'); viewContent(); } catch (e) { alert(e.message); } } }, 'Mark as posted'));
    if (p.status === 'approved') b.push(h('button', { class: 'btn small ghost', onclick: async () => { await api('POST', `content/${p.id}/schedule`, {}); viewContent(); } }, 'Mark scheduled'));
    if (mine && ['idea', 'draft', 'changes_requested', 'approved'].includes(p.status)) b.push(h('button', { class: 'btn small ghost', onclick: async () => { const c = prompt('Edit caption:', p.caption); if (c === null) return; const body = { caption: c }; if (p.status === 'approved') { if (!confirm('This post is approved. Editing it sends it back to Dion for approval. Continue?')) return; body.confirmReapproval = true; } try { await api('PATCH', `content/${p.id}`, body); viewContent(); } catch (e) { alert(e.message); viewContent(); } } }, 'Edit'));
    if (mine && !['published', 'cancelled'].includes(p.status)) b.push(h('button', { class: 'btn small ghost', onclick: async () => { if (confirm('Cancel this post?')) { await api('POST', `content/${p.id}/cancel`); viewContent(); } } }, 'Cancel'));
    return h('div', { class: 'row' }, b);
  };
  const active = d.posts.filter(p => !['published', 'cancelled'].includes(p.status));
  const done = d.posts.filter(p => ['published', 'cancelled'].includes(p.status));
  const card = p => h('div', { class: 'card' },
    h('div', { class: 'row' }, h('span', { class: 'tag ' + (p.status === 'approved' || p.status === 'published' ? 'approved' : ['in_review', 'changes_requested'].includes(p.status) ? 'pending' : '') }, L(p.status)), h('span', { class: 'tag' }, L(p.channel)), h('span', { class: 'tag' }, p.plannedDate ? fmtDate(p.plannedDate) : 'No date')),
    h('p', { class: 'pre' }, p.caption || h('span', { class: 'muted' }, 'No caption yet')),
    h('p', { class: 'muted' }, 'Link: ', p.refLink, p.assetTitle ? ` · Graphic: ${p.assetTitle}` : ''),
    p.publishedUrl ? h('p', {}, h('a', { href: p.publishedUrl, target: '_blank', rel: 'noopener noreferrer' }, 'View the live post')) : null,
    h('p', { class: 'muted' }, `By ${p.createdByName || 'team'}`), actions(p));
  layout('content', h('h1', {}, 'Social calendar'), h('p', { class: 'sub' }, 'Draft posts here. Every post gets Dion\'s OK before it goes live; then post it from the SpinFamily account and mark it posted.'),
    h('details', { open: !d.posts.length }, h('summary', {}, 'New post'), form),
    h('h2', {}, 'Coming up'), active.length ? h('div', { class: 'grid' }, active.map(card)) : h('p', { class: 'muted' }, 'No posts planned yet.'),
    done.length ? h('details', {}, h('summary', {}, `Posted and cancelled (${done.length})`), h('div', { class: 'grid' }, done.map(card))) : null);
}

// ---------- Research & testing ----------
async function viewResearch() {
  const [d, ps] = await Promise.all([api('GET', 'research'), api('GET', 'participants')]);
  const manage = can('research.manage');
  const cohortForm = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(cohortForm, async () => { await api('POST', 'research/cohorts', formData(cohortForm)); toast('Cohort added'); viewResearch(); }); } },
    h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 120, placeholder: "Marilyn's parent testers" })), h('div', { class: 'row' }, h('label', {}, 'Partner', h('input', { name: 'partner', maxlength: 120 })), h('label', {}, 'Planned size', h('input', { name: 'plannedSize', type: 'number', min: 0 })), h('label', {}, 'Results due', h('input', { name: 'deadline', type: 'date' }))),
    h('label', {}, 'How the testing works', h('textarea', { name: 'protocol', maxlength: 3000, placeholder: 'First session to sign up, then two or three short check-ins over a few days. Free features only.' })), h('button', { class: 'btn', type: 'submit' }, 'Add cohort'));
  const cohortCard = c => {
    const box = h('div');
    const enroll = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(enroll, async () => { await api('POST', `research/cohorts/${c.id}/enroll`, formData(enroll)); toast('Added'); viewResearch(); }); } },
      h('label', {}, 'Participant', h('select', { name: 'participantId', required: true }, ps.participants.map(p => h('option', { value: p.id }, p.firstName)))), h('label', {}, 'Status', select('status', ['invited', 'consented', 'active', 'completed', 'withdrawn'], 'invited')), h('button', { class: 'btn small', type: 'submit' }, 'Add'));
    const session = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(session, async () => { const b = formData(session); await api('POST', 'research/sessions', { ...b, cohortId: c.id, completed: !!session.querySelector('input[name=completed]:checked') }); toast('Session logged'); viewResearch(); }); } },
      h('div', { class: 'row' }, h('label', {}, 'Participant', h('select', { name: 'participantId', required: true }, ps.participants.map(p => h('option', { value: p.id }, p.firstName)))), h('label', {}, 'Kind', select('kind', d.sessionKinds, 'initial')), h('label', {}, 'Date', h('input', { name: 'scheduledFor', type: 'date' }))),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'completed' }), 'Done'), h('label', {}, 'What you saw', h('textarea', { name: 'observations', maxlength: 3000 })), h('button', { class: 'btn small', type: 'submit' }, 'Log session'));
    const toggle = h('button', { class: 'btn small ghost', onclick: async () => { const x = await api('GET', `research/cohorts/${c.id}`); clear(box).append(h('h3', {}, 'People'), x.enrollments.length ? h('ul', {}, x.enrollments.map(e => h('li', {}, `${e.firstName}: ${L(e.status)}`))) : h('p', { class: 'muted' }, 'Nobody yet.'), x.hiddenCount ? h('p', { class: 'muted' }, `${x.hiddenCount} more not assigned to you.`) : null, h('h3', {}, 'Sessions'), x.sessions.length ? h('ul', {}, x.sessions.map(s => h('li', {}, `${fmtDate(s.scheduled_for)} · ${L(s.kind)}${s.completed_at ? ' · done' : ''}${s.observations ? ': ' + s.observations : ''}`))) : h('p', { class: 'muted' }, 'None logged.')); } }, 'Show people and sessions');
    return h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'tag ' + (c.status === 'active' ? 'approved' : '') }, L(c.status)), c.deadline ? h('span', { class: 'tag pending' }, 'Due ' + fmtDate(c.deadline)) : null),
      h('h3', {}, c.name), c.partner ? h('p', { class: 'muted' }, 'With ' + c.partner) : null,
      h('p', {}, `${c.enrolled}${c.plannedSize ? ' of ' + c.plannedSize + ' planned' : ''} people · ${c.sessionsDone} sessions done`, c.enrolled < (c.plannedSize || 0) ? h('span', { class: 'muted' }, ' (planned, not yet actual)') : null),
      c.protocol ? h('details', {}, h('summary', {}, 'How it works'), h('p', { class: 'pre' }, c.protocol)) : null,
      manage ? h('div', { class: 'row' }, select('status', d.cohortStatuses, c.status, { 'aria-label': 'Status', onchange: async e => { await api('PATCH', `research/cohorts/${c.id}`, { status: e.target.value }); viewResearch(); } })) : null,
      h('details', {}, h('summary', {}, 'Add someone'), enroll), h('details', {}, h('summary', {}, 'Log a session'), session), toggle, box);
  };
  const surveyCard = s => h('div', { class: 'card' }, h('div', { class: 'row' }, h('span', { class: 'tag ' + (s.status === 'approved' ? 'approved' : s.status === 'draft' ? 'pending' : 'retired') }, L(s.status)), h('span', { class: 'tag' }, 'Version ' + s.version)),
    h('h3', {}, h('a', { href: '#/research/' + s.id }, s.title)), h('p', { class: 'muted' }, `${s.questions.length} questions · ${s.invites} links sent · ${s.responses} answered`));
  layout('research', h('h1', {}, 'Research & testing'), h('p', { class: 'sub' }, 'Testing groups, sessions and the parent questionnaire.'),
    h('h2', {}, 'Testing groups'), d.cohorts.length ? h('div', { class: 'grid' }, d.cohorts.map(cohortCard)) : h('p', { class: 'muted' }, 'No testing groups yet.'),
    manage ? h('details', {}, h('summary', {}, 'Add a testing group'), cohortForm) : null,
    h('h2', {}, 'Questionnaires'), h('div', { class: 'grid' }, d.surveys.map(surveyCard)));
}

async function viewSurvey(id) {
  const d = await api('GET', 'research');
  const s = d.surveys.find(x => x.id === id); if (!s) throw new Error('Not found.');
  const ps = await api('GET', 'participants');
  const linkBox = h('div');
  const invite = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(invite, async () => {
    const r = await api('POST', 'research/invites', { surveyId: s.id, ...formData(invite) });
    clear(linkBox).append(h('div', { class: 'notice' }, h('p', {}, h('b', {}, 'Private link (shown once, works once, 30 days): ')), h('p', { class: 'mono' }, r.link), h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(r.link); toast('Copied'); } catch { toast('Select the link and copy it'); } } }, 'Copy link'), h('p', { class: 'muted' }, 'Send it to them yourself. Approved message wording is in Approvals.')));
  }); } },
    h('label', {}, 'Participant', h('select', { name: 'participantId', required: true }, ps.participants.filter(p => p.isTest !== true).map(p => h('option', { value: p.id }, p.firstName)))),
    d.cohorts.length ? h('label', {}, 'Testing group (optional)', h('select', { name: 'cohortId' }, h('option', { value: '' }, 'None'), d.cohorts.map(c => h('option', { value: c.id }, c.name)))) : null,
    h('button', { class: 'btn', type: 'submit' }, 'Create private link'));
  let results = null;
  if (s.responses) results = await api('GET', `research/surveys/${s.id}/results`);
  const edit = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(edit, async () => { let qs; try { qs = JSON.parse(formData(edit).questions); } catch { throw new Error('The questions are not valid JSON.'); } const r = await api('PATCH', `research/surveys/${s.id}`, { questions: qs, intro: formData(edit).intro }); toast(s.status === 'draft' ? 'Draft saved' : 'Saved as a new draft version'); location.hash = '#/research/' + r.survey.id; }); } },
    h('label', {}, 'Introduction', h('textarea', { name: 'intro', maxlength: 1000 }, s.intro)), h('label', {}, 'Questions (advanced: JSON)', h('textarea', { name: 'questions', class: 'mono', rows: 14 }, JSON.stringify(s.questions, null, 2))), h('button', { class: 'btn ghost', type: 'submit' }, s.status === 'draft' ? 'Save draft' : 'Save as a new version'));
  layout('research', h('p', {}, h('a', { href: '#/research' }, '← Research & testing')), h('h1', {}, `${s.title} (v${s.version})`),
    h('div', { class: 'notice ' + (s.status === 'approved' ? '' : 'warn') }, s.status === 'approved' ? `Approved ${fmtDate(s.approvedAt)}. Parents can answer it through private links.` : s.status === 'draft' ? 'Draft. Dion has to approve it before any parent sees it.' : 'Retired. A newer version replaced it.'),
    s.status === 'draft' ? h('button', { class: 'btn', onclick: async () => { try { await api('POST', `research/surveys/${s.id}/submit`); toast('Sent to Dion for approval'); } catch (e) { alert(e.message); } } }, 'Send for approval') : null,
    s.status === 'approved' ? [h('h2', {}, 'Send it to a parent'), invite, linkBox] : null,
    results ? [h('h2', {}, `Answers (${results.responses})`), h('div', { class: 'grid' }, results.summary.map(q => h('div', { class: 'card' }, h('b', {}, q.text), h('p', { class: 'muted' }, `${q.answered} answered${q.average !== null && q.average !== undefined ? ' · average ' + q.average : ''}`),
      q.counts ? h('ul', {}, Object.entries(q.counts).map(([k, v]) => h('li', {}, `${k}: ${v}`))) : null, q.answers?.length ? h('ul', {}, q.answers.map(a => h('li', {}, a))) : q.note ? h('p', { class: 'muted' }, q.note) : null)))] : null,
    h('h2', {}, 'Questions'), h('p', { class: 'muted' }, s.intro),
    h('ol', {}, s.questions.map(q => h('li', {}, q.text, h('span', { class: 'muted' }, ` (${q.type === 'choice' ? q.options.join(' / ') : q.type === 'scale' ? `1–${q.max}` : q.type === 'yesno' ? 'yes / no' : 'written answer'})`)))),
    can('surveys.draft') ? h('details', {}, h('summary', {}, 'Edit'), edit) : null);
}

// ---------- router ----------
async function route() {
  if (!ME) return loginScreen();
  let [, view, id] = (location.hash || '#/dashboard').split('/');
  if (ME.needsAuthenticator || ME.mfa !== 'verified') view = 'team';
  try {
    if (view === 'approvals') await viewApprovals();
    else if (view === 'content') await viewContent();
    else if (view === 'research') await (id ? viewSurvey(id) : viewResearch());
    else if (view === 'participants') await (id ? viewParticipant(id) : viewParticipants());
    else if (view === 'followups') await viewFollowups();
    else if (view === 'outreach') await viewOutreach();
    else if (view === 'relationships') await (id ? viewRelationship(id) : viewRelationships());
    else if (view === 'docs' || view === 'resources') await viewResources();
    else if (view === 'team') await viewTeam();
    else await viewDashboard();
    document.getElementById('main')?.focus();
  } catch (e) {
    if (!ME) return;
    layout(view, h('h1', {}, 'Something went wrong'), errorBox(e), h('p', {}, h('a', { href: '#/dashboard' }, 'Back to Today')));
  }
}

async function boot(hash) {
  try { ME = await api('GET', 'auth/me'); }
  catch (e) { ME = null; return e.code === 'mfa_required' ? mfaScreen() : loginScreen(); }
  if (ME.mfa === 'pending') return mfaScreen();
  if (hash) location.hash = hash;
  if (!location.hash || location.hash.startsWith('#signin')) location.hash = '#/dashboard';
  route();
}

window.addEventListener('hashchange', () => { if (location.hash.startsWith('#signin=')) consumeSignInLink(); else if (ME) route(); });
consumeSignInLink().then(used => { if (!used) boot(); });
})();
