// SpinFamily parent questionnaire. The link's token stays in the page (never sent to analytics or other sites).
(() => {
'use strict';
const root = document.getElementById('survey');
const m = location.hash.match(/^#t=([\w-]{20,100})$/);
const token = m ? m[1] : '';
history.replaceState(null, '', '/pilot/survey/');
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
const show = (...nodes) => { while (root.firstChild) root.firstChild.remove(); root.append(h('div', { class: 'login' }, h('p', {}, h('span', { class: 'logo' }, 'Spin', h('em', {}, 'Family'))), h('div', { class: 'card' }, ...nodes))); };
async function post(path, body) {
  const r = await fetch('/operations/api/public/survey/' + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sf-ops': '1' }, body: JSON.stringify({ token, ...body }) });
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d?.error?.message || 'Something went wrong. Please try again.');
  return d;
}
function field(q) {
  const name = q.id;
  if (q.type === 'text') return h('textarea', { name, maxlength: 2000, 'aria-label': q.text });
  if (q.type === 'yesno') q = { ...q, options: ['yes', 'no'], labels: ['Yes', 'No'] };
  if (q.type === 'scale') {
    const opts = []; for (let i = q.min; i <= q.max; i++) opts.push(i);
    return h('div', {}, h('div', { class: 'row', role: 'radiogroup', 'aria-label': q.text }, opts.map(i => h('label', { class: 'row' }, h('input', { type: 'radio', name, value: i }), String(i)))), h('p', { class: 'muted' }, `${q.min} = ${q.minLabel || 'low'}, ${q.max} = ${q.maxLabel || 'high'}`));
  }
  return h('div', { role: 'radiogroup', 'aria-label': q.text }, q.options.map((o, i) => h('label', { class: 'row' }, h('input', { type: 'radio', name, value: o }), q.labels ? q.labels[i] : o)));
}
async function start() {
  if (!token) return show(h('h1', {}, 'Link not found'), h('p', {}, 'Please open the full link from your SpinFamily email or message.'));
  let s;
  try { s = await post('load', {}); } catch (e) { return show(h('h1', {}, 'This link can\'t be used'), h('p', {}, e.message)); }
  let section = null;
  const items = [];
  for (const q of s.questions) {
    if (q.section && q.section !== section) { section = q.section; items.push(h('h2', {}, section)); }
    items.push(h('fieldset', { class: 'card' }, h('legend', {}, q.text), field(q)));
  }
  // The participation notice comes first. Agreeing is a separate, unticked box (R2-05).
  const notice = h('div', { class: 'card' }, h('h2', {}, 'Before you start'), h('ul', {}, s.notice.text.map(t => h('li', {}, t))), h('p', { class: 'muted' }, `Notice ${s.notice.version}`));
  const consent = s.consentOnFile ? null : h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'consent', required: true }), 'I have read this and agree to take part.');
  const form = h('form', { class: 'stack', onsubmit: async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]'); btn.disabled = true;
    const answers = {};
    for (const q of s.questions) {
      if (q.type === 'text') { const v = form.elements[q.id].value.trim(); if (v) answers[q.id] = v; }
      else { const c = form.querySelector(`input[name="${q.id}"]:checked`); if (c) answers[q.id] = q.type === 'scale' ? Number(c.value) : c.value; }
    }
    const agreed = s.consentOnFile || form.querySelector('input[name=consent]')?.checked === true;
    try { await post('submit', { answers, consent: agreed, noticeVersion: s.notice.version }); show(h('h1', {}, 'Thank you!'), h('p', {}, 'Your answers were sent to the SpinFamily team. They help us make family time easier to plan.')); }
    catch (err) { btn.disabled = false; form.prepend(h('div', { class: 'notice err', role: 'alert' }, err.message)); }
  } }, ...items, consent, h('button', { class: 'btn', type: 'submit' }, 'Send my answers'));
  const withdraw = h('button', { class: 'btn ghost small', type: 'button', onclick: async () => {
    if (!confirm('Withdraw from SpinFamily research? We will stop asking you questions.')) return;
    try { const r = await post('withdraw', {}); show(h('h1', {}, 'You have withdrawn'), h('p', {}, r.message)); }
    catch (err) { root.prepend(h('div', { class: 'notice err', role: 'alert' }, err.message)); }
  } }, 'Withdraw from research');
  show(h('h1', {}, s.title), h('p', { class: 'sub' }, s.intro), notice, form, h('details', {}, h('summary', {}, 'Don\'t want to take part?'), h('p', { class: 'muted' }, 'You can withdraw at any time. This stops all SpinFamily research questions.'), withdraw));
}
start();
})();
