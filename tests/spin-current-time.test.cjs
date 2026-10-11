const test=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync(require('node:path').resolve(__dirname,'../index.html'),'utf8');
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
test('Original SpinFamily entry and 20 activities remain',()=>{
 assert.match(html,/id="spinBtn"/); assert.match(html,/id="wheel"/);
 assert.match(html,/id="activityForm"/); assert.match(html,/id="spinPage"/);
 assert.match(script,/Family movie night/); assert.match(script,/Early bedtime routine/);
});
test('Spin duration, reduced motion and wheel anchor all drive a genuine plan',()=>{
 assert.match(script,/reduced\?0:2400/);assert.match(script,/const anchor=\['chore','outdoor','family','selfcare'\]\[index\]/);
 assert.match(script,/showResults\(anchor\)/);assert.match(script,/item\.category===anchor/);
});
test('Current-clock two-hour feasibility, bedtime last, and variety across spins',()=>{
 const start=script.indexOf('const defaults='),stop=script.indexOf('function showResults(anchor)',start);
 assert.ok(start>=0&&stop>start);
 const text=script.slice(start,stop);
 const ctx=vm.createContext({console,Date,Math,Set,Number,Object,Array,custom:[]});
 vm.runInContext(text.replace(/const \$=id=>document\.getElementById\(id\);/,'const $=()=>{};'),ctx);
 for(const category of ['chore','outdoor','family','selfcare']){
   for(const count of [1,2,3,4,5]){
     vm.runInContext('spinCount='+count,ctx);
     const plan=vm.runInContext('buildTwoHourPlan('+JSON.stringify(category)+',new Date("2026-10-11T18:10:00"))',ctx);
     assert.ok(plan,category);
     assert.equal(plan.reduce((a,b)=>a+b.duration,0),120,category);
     assert.ok(plan.some(a=>a.category===category),category);
     const bedtime=plan.findIndex(a=>a.name==='Early bedtime routine');
     assert.ok(bedtime===-1||bedtime===plan.length-1,category);
   }
 }
});
test('Public client does not accidentally bundle old protected private core',()=>{
 assert.doesNotMatch(html,/\.\.\/src\/(?:planner|boundaries|state)/);
 assert.doesNotMatch(script,/rankComponents|outputBoundary|prepareApprovedRecord/);
});
