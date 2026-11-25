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
  clear(app).append(h('div', { class: 'center' }, h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', {}, 'One more step'), message ? h('div', { class: 'notice warn' }, message) : null, form))));
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
  ['dashboard', 'Today', 'dashboard.view'], ['participants', 'Participants', 'participants.view.assigned'], ['followups', 'Follow-ups', 'followups.manage'],
  ['outreach', 'Outreach log', 'outreach.record'], ['relationships', 'Relationships', 'relationships.record'], ['resources', 'Materials', 'resources.view'], ['team', 'Team & security', null],
];
function layout(active, ...content) {
  const nav = h('nav', { class: 'side', 'aria-label': 'Workspace' }, NAV.filter(([, , p]) => !p || can(p)).map(([id, label]) => h('a', { href: '#/' + id, 'aria-current': active === id ? 'page' : null, onclick: () => nav.classList.remove('open') }, label)));
  clear(app).append(
    h('header', { class: 'top' },
      h('div', { class: 'row' }, h('button', { class: 'btn ghost small menu', 'aria-label': 'Menu', onclick: () => nav.classList.toggle('open') }, 'Menu'), h('a', { class: 'logo', href: '#/dashboard' }, 'Spin', h('em', {}, 'Family'), h('small', {}, 'Ops'))),
      h('div', { class: 'who' }, h('b', {}, ME.member.name), ' · ', ME.member.roleLabel, h('br'), h('span', { class: 'email' }, ME.member.email + ' · '), h('a', { href: '#', onclick: async e => { e.preventDefault(); await api('POST', 'auth/logout').catch(() => {}); ME = null; loginScreen('You are signed out.'); } }, 'Sign out'))),
    h('div', { class: 'shell' }, nav, h('main', { id: 'main', tabindex: '-1' },
      ME.previewDeploy ? h('div', { class: 'notice warn' }, 'Preview deploy: test data only. Nothing here is the real participant list.') : null,
      ME.needsAuthenticator ? h('div', { class: 'notice warn' }, 'Set up your authenticator app under ', h('a', { href: '#/team' }, 'Team & security'), ' to unlock team management, contact details and approvals.') : null,
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
    h('h2', {}, 'Add a participant'), h('p', { class: 'muted' }, 'Adults only. Never record children\'s names, birthdays, schools, photos or health details.'), form);
}

async function viewParticipant(id) {
  const [d, team] = await Promise.all([api('GET', 'participants/' + id), can('team.manage') ? api('GET', 'team').catch(() => null) : null]);
  const p = d.participant;
  const states = { cohort: ['pilot', 'beta', 'research', 'prospect'], enrollment: ['prospect', 'registration_received', 'eligibility_confirmed', 'enrolled', 'withdrawn', 'archived'], account: ['unknown', 'not_found', 'created', 'confirmation_pending', 'confirmed', 'disabled'], engagement: ['unknown', 'not_started', 'first_plan_generated', 'first_plan_accepted', 'first_activity_completed', 'repeat_use_observed', 'survey_submitted', 'pilot_completed'], communication: ['unknown', 'not_sent', 'queued', 'smtp_accepted', 'delivery_confirmed', 'bounced', 'failed', 'uncertain', 'opted_out'] };
  const form = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(form, async () => {
    const body = formData(form);
    if ('isTest' in body) body.isTest = body.isTest === 'yes';
    if (body.assignedTo === '') body.assignedTo = null;
    await api('PATCH', 'participants/' + id, body); toast('Saved'); viewParticipant(id);
  }); } },
    ...Object.entries(states).map(([f, list]) => h('label', {}, ({ cohort: 'Cohort', enrollment: 'Enrollment', account: 'App account', engagement: 'Engagement', communication: 'Pilot emails' })[f], select(f, list, p[f]))),
    h('label', {}, 'How they heard (team report)', select('reportedSource', ['instagram', 'facebook', 'fbgroups', 'tiktok', 'lindsey', 'campus', 'campus-groups', 'direct', 'other', 'unknown'], p.reportedSource)),
    team ? h('label', {}, 'Assigned to', h('select', { name: 'assignedTo' }, h('option', { value: '' }, 'Nobody'), team.members.filter(m => m.status !== 'revoked').map(m => h('option', { value: m.id, selected: m.id === p.assignedTo }, m.name)))) : null,
    can('participants.markTest') ? h('label', {}, 'Internal test entry?', h('select', { name: 'isTest' }, h('option', { value: 'no', selected: p.isTest === false }, 'No, a real participant'), h('option', { value: 'yes', selected: p.isTest === true }, 'Yes, exclude from counts'))) : null,
    h('label', {}, 'Notes', h('textarea', { name: 'notes', maxlength: 1000 }, p.notes || '')),
    h('button', { class: 'btn', type: 'submit' }, 'Save changes'));
  layout('participants',
    h('p', {}, h('a', { href: '#/participants' }, '← Participants')),
    h('h1', {}, p.firstName), h('p', { class: 'sub' }, p.email || 'No email on file', p.emailMasked ? ' (hidden: not assigned to you)' : ''),
    h('div', { class: 'card' }, h('p', {}, h('b', {}, 'Link source from the sign-up form: '), p.technicalSource ? L(p.technicalSource) : 'Not from the form'), h('p', { class: 'muted' }, 'The form\'s link source is kept as recorded. Use "How they heard" for what the person or the team reports.'), p.intake ? h('p', {}, h('b', {}, 'Form received: '), fmtDate(p.intake.receivedAt)) : null),
    p.isTest === null && can('participants.markTest') ? h('div', { class: 'notice warn' }, 'This form registration hasn\'t been reviewed yet. Mark whether it is an internal test.') : null,
    h('h2', {}, 'Status'), form,
    h('h2', {}, 'History'), h('p', { class: 'muted' }, 'Every change is recorded and can\'t be edited.'),
    d.history.length ? h('ul', {}, d.history.map(x => h('li', {}, `${fmtDate(x.at)}: `, x.changes.map(c => `${c.field} ${c.from !== undefined ? L(c.from) + ' → ' : ''}${L(c.to)}`).join('; ')))) : h('p', { class: 'muted' }, 'No changes yet.'));
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
  const edit = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(edit, async () => { await api('PATCH', 'relationships/' + id, formData(edit)); toast('Saved'); viewRelationship(id); }); } },
    h('div', { class: 'row' }, h('label', {}, 'Stage', select('stage', d.stages, r.stage)), h('label', {}, 'Next action date', h('input', { name: 'nextActionDate', type: 'date', value: r.nextActionDate || '' }))),
    h('label', {}, 'Next action', h('input', { name: 'nextAction', maxlength: 200, value: r.nextAction || '' })),
    h('label', {}, 'Notes', h('textarea', { name: 'notes', maxlength: 1000 }, r.notes || '')),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));
  const log = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(log, async () => { await api('POST', `relationships/${id}/log`, formData(log)); toast('Logged'); viewRelationship(id); }); } },
    h('label', {}, 'Type', select('kind', ['meeting', 'demo', 'call', 'email', 'note'], 'meeting')), h('label', {}, 'What happened', h('input', { name: 'summary', required: true, maxlength: 500 })), h('button', { class: 'btn', type: 'submit' }, 'Add'));
  layout('relationships', h('p', {}, h('a', { href: '#/relationships' }, '← Relationships')), h('h1', {}, r.contactName), h('p', { class: 'sub' }, `${r.organization}${r.office ? ' · ' + r.office : ''}`),
    h('div', { class: 'notice' }, r.offerApproved ? 'Dion has approved making offers to this contact.' : 'No offers approved yet. Share approved materials only, and check with Dion before promising anything.'),
    edit, h('h2', {}, 'Contact log'), log, (r.log || []).length ? h('ul', {}, [...r.log].reverse().map(x => h('li', {}, `${fmtDate(x.at)} · ${x.kind}: ${x.summary}`))) : h('p', { class: 'muted' }, 'Nothing logged yet.'));
}

async function viewResources() {
  const d = await api('GET', 'resources');
  const manage = can('resources.manage');
  layout('resources', h('h1', {}, 'Materials'), h('p', { class: 'sub' }, 'Use approved materials as-is. Anything pending review needs Dion\'s OK first.'),
    h('div', { class: 'grid' }, d.resources.map(r => h('div', { class: 'card' }, h('span', { class: 'tag ' + r.approval }, L(r.approval)), h('h3', {}, h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title)), h('p', { class: 'muted' }, r.intendedUse),
      manage ? h('div', { class: 'row' }, select('approval', d.approvals, r.approval, { 'aria-label': 'Approval for ' + r.title, onchange: async e => { await api('PATCH', 'resources/' + r.id, { approval: e.target.value }); toast('Updated'); } })) : null))));
}

async function viewTeam() {
  const parts = [h('h1', {}, 'Team & security')];
  // Authenticator
  const sec = h('div', { class: 'card' });
  if (ME.member.role === 'founder') {
    if (ME.needsAuthenticator || ME.member.mfaEnabled === false) {
      sec.append(h('h2', {}, 'Set up your authenticator app'), h('p', {}, 'Founder access needs a second step: a 6-digit code from an app like Google Authenticator, Microsoft Authenticator or 1Password.'),
        h('button', { class: 'btn', onclick: async () => {
          const s = await api('POST', 'auth/authenticator/setup');
          const f = h('form', { class: 'stack', onsubmit: e => { e.preventDefault(); submitting(f, async () => { await api('POST', 'auth/authenticator/confirm', formData(f)); toast('Authenticator turned on'); boot('#/team'); }); } },
            h('p', {}, '1. In your authenticator app, add an account and choose "Enter a setup key". Use this key (time-based):'), h('p', { class: 'mono' }, s.secret.replace(/(.{4})/g, '$1 ').trim()),
            h('p', {}, h('a', { href: s.uri }, 'Or tap here on your phone to add it directly')),
            h('label', {}, '2. Enter the 6-digit code it shows', h('input', { name: 'code', inputmode: 'numeric', pattern: '[0-9]{6}', maxlength: 6, required: true, autocomplete: 'one-time-code' })),
            h('button', { class: 'btn', type: 'submit' }, 'Turn on'));
          clear(sec).append(h('h2', {}, 'Set up your authenticator app'), f);
        } }, 'Start setup'));
    } else sec.append(h('h2', {}, 'Authenticator'), h('p', {}, 'On. You\'ll be asked for a code each time you sign in.'));
  } else sec.append(h('h2', {}, 'Your access'), h('p', {}, `${ME.member.roleLabel}. Sign-in links go to ${ME.member.email}.`), h('p', { class: 'muted' }, 'To change your access, ask Dion.'));
  parts.push(sec);

  if (can('team.manage')) {
    const t = await api('GET', 'team');
    const form = h('form', { class: 'inline', onsubmit: e => { e.preventDefault(); submitting(form, async () => { await api('POST', 'team/invite', formData(form)); toast('Added. They can now request a sign-in link.'); viewTeam(); }); } },
      h('label', {}, 'Name', h('input', { name: 'name', required: true, maxlength: 80 })), h('label', {}, 'Email', h('input', { name: 'email', type: 'email', required: true, maxlength: 120 })),
      h('label', {}, 'Role', select('role', t.roles.map(r => r.id).filter(r => r !== 'founder'), 'coordinator')), h('label', {}, 'Title', h('input', { name: 'title', maxlength: 80, placeholder: 'Community & Programs Coordinator' })),
      h('button', { class: 'btn', type: 'submit' }, 'Give access'));
    parts.push(h('h2', {}, 'Team members'),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', 'Last sign-in', ''].map(x => h('th', { scope: 'col' }, x)))),
        h('tbody', {}, t.members.map(m => h('tr', {}, h('td', {}, m.name, h('br'), h('span', { class: 'muted' }, m.title)), h('td', {}, m.email), h('td', {}, m.roleLabel), h('td', {}, m.status), h('td', {}, fmtDate(m.lastSignInAt)),
          h('td', {}, m.id === ME.member.id ? 'You' : h('div', { class: 'row' },
            m.status === 'revoked' ? h('button', { class: 'btn small ghost', onclick: async () => { await api('PATCH', 'team/' + m.id, { action: 'restore' }); viewTeam(); } }, 'Restore') : h('button', { class: 'btn small ghost', onclick: async () => { if (confirm(`Remove ${m.name}'s access? They will be signed out right away.`)) { await api('PATCH', 'team/' + m.id, { action: 'revoke' }); viewTeam(); } } }, 'Remove access'),
            m.status === 'active' ? h('button', { class: 'btn small ghost', onclick: async () => { await api('PATCH', 'team/' + m.id, { action: 'sign_out_everywhere' }); toast('Signed out everywhere'); } }, 'Sign out everywhere') : null))))))),
      h('h2', {}, 'Give someone access'), h('p', { class: 'muted' }, 'They sign in with a link sent to this email. Nobody can sign up on their own.'), form);
    if (can('audit.view')) {
      const a = await api('GET', 'audit');
      parts.push(h('details', {}, h('summary', {}, 'Activity log (last 200)'), h('ul', {}, a.audit.map(x => h('li', {}, `${new Date(x.at).toLocaleString()} · ${x.action}${x.target ? ' · ' + x.target : ''}`)))));
    }
  } else if (ME.member.role === 'founder') parts.push(h('div', { class: 'notice warn' }, 'Team management unlocks once your authenticator is on and you\'ve entered a code this session.'));
  layout('team', ...parts);
}

// ---------- router ----------
async function route() {
  if (!ME) return loginScreen();
  const [, view, id] = (location.hash || '#/dashboard').split('/');
  try {
    if (view === 'participants') await (id ? viewParticipant(id) : viewParticipants());
    else if (view === 'followups') await viewFollowups();
    else if (view === 'outreach') await viewOutreach();
    else if (view === 'relationships') await (id ? viewRelationship(id) : viewRelationships());
    else if (view === 'resources') await viewResources();
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
