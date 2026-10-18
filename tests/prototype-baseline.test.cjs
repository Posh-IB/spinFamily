// Protect the current public prototype; these are NOT feasibility-release tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const html = readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');

function prototype(seed = 1) {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, { value: '', textContent: '', innerHTML: '', disabled: false,
        handlers: {}, classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) },
        style: {}, focus() {}, addEventListener(event, fn) { this.handlers[event] = fn; } });
    }
    return nodes.get(id);
  }
  const math = Object.create(Math);
  math.random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const sandbox = vm.createContext({ Math: math, setTimeout: fn => fn(), alert() {}, window: { scrollTo() {} },
    document: { getElementById: node, querySelectorAll: () => [], addEventListener() {},
      createElement() { return { set textContent(v) { this.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }; } } });
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(x => x[1]);
  assert.equal(scripts.length, 1, 'Update harness explicitly if script boundaries change');
  vm.runInContext(scripts[0], sandbox);
  return { node, run: code => vm.runInContext(code, sandbox) };
}

test('catalog retains four categories, 20 named activities and positive durations', () => {
  const p = prototype();
  assert.equal(p.run('Object.keys(defaults).length'), 4);
  assert.equal(p.run('Object.values(defaults).flat().length'), 20);
  assert.equal(p.run('Object.values(defaults).flat().every(x => x[1] && x[2] > 0)'), true);
});
test('500 seeded spins select three distinct categories with valid catalog entries', () => {
  const p = prototype();
  for (let i = 0; i < 500; i++) {
    assert.equal(p.run('(() => { const p = generatePlan(); return p.length === 3 && new Set(p.map(x => x.category)).size === 3 && p.every(x => defaults[x.category].some(a => a[1] === x.name && a[2] === x.duration)); })()'), true);
  }
});
test('bedtime is last whenever selected across 500 seeded spins', () => {
  const p = prototype(29);
  let occurrences = 0;
  for (let i = 0; i < 500; i++) {
    const at = p.run('generatePlan().findIndex(x => x.name === "Early bedtime routine")');
    if (at >= 0) { occurrences++; assert.equal(at, 2); }
  }
  assert.ok(occurrences > 0, 'Actually exercise bedtime');
});
test('setup precedes leisure and wind-down across 500 seeded spins', () => {
  const p = prototype(41);
  for (let i = 0; i < 500; i++) assert.equal(p.run('(() => { const p = generatePlan(); const i = p.findIndex(x => x.category === "chore"); return i === -1 || i === 0; })()'), true);
});
test('sequencing does not mutate caller array or activity fields', () => {
  const p = prototype();
  assert.equal(p.run('(() => {const a = [{category:"selfcare",name:"Early bedtime routine",duration:45},{category:"chore",name:"Reset",duration:10},{category:"family",name:"Game",duration:20}]; const before=JSON.stringify(a); sequencePlan(a); return before===JSON.stringify(a);})()'), true);
});
test('custom activities can be selected and remain session only', () => {
  const p = prototype(2);
  p.run('custom.push({name:"Build a fort",category:"family"})');
  let found = false;
  for (let i = 0; i < 500; i++) found ||= p.run('generatePlan().some(x => x.name === "Build a fort" && x.duration === 20)');
  assert.ok(found);
  assert.equal(prototype().run('custom.length'), 0);
});
test('basic term screening rejects named prohibited terms', () => {
  const p = prototype();
  assert.equal(p.run('["fuck","shit","bitch","cocaine","heroin","meth","porn"].every(s => prohibited.some(re => re.test(s)))'), true);
});
test('ordinary family terms do not trigger substring false positives', () => {
  const p = prototype();
  assert.equal(p.run('["sleepover","classical music","method drawing","Scunthorpe story"].every(s => !prohibited.some(re => re.test(s)))'), true);
});
test('activity titles are HTML escaped', () => {
  const p = prototype();
  assert.equal(p.run('escapeHtml("<img src=x onerror=alert(1)>")'), '&lt;img src=x onerror=alert(1)&gt;');
});
test('displaying a plan never automatically accepts it', () => {
  const p = prototype();
  p.run('showResults()');
  assert.equal(p.node('acceptedStatus').textContent, '');
  p.node('acceptBtn').handlers.click();
  assert.match(p.node('acceptedStatus').textContent, /Plan selected for tonight/);
});
test('prototype maintains accurate no-ML and no-long-term-history copy', () => {
  assert.match(html, /does not use machine learning/);
  assert.match(html, /does not record completion, streaks, or long-term history/);
  assert.doesNotMatch(html, /localStorage\s*\.|sessionStorage\s*\./);
});
test('zoom, reduced-motion styles and named dialog/status hooks remain present', () => {
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /role="dialog" aria-labelledby="resultTitle"/);
  assert.match(html, /id="acceptedStatus"[^>]*role="status"/);
});
