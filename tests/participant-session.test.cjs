const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs');
const html=fs.readFileSync(require('path').join(__dirname,'../index.html'),'utf8');
test('participant follows between Home, Activities, and Family within one session',()=>{
 assert.match(html,/function selectParticipant\(member\)/);
 assert.match(html,/button\.dataset\.member===member/);
 assert.match(html,/button\.dataset\.familyMember===member/);
 assert.match(html,/activityParticipantName'\)\.textContent='Choosing with '\+member/);
 assert.match(html,/activityParticipantSelect'\)\.value=member/);
});
test('anonymous free session has no durable participant history or billing claims',()=>{
 assert.doesNotMatch(html,/(?:localStorage|sessionStorage)\.setItem/);
 assert.match(html,/Anonymous spins and two-hour suggestions are free/);
 assert.match(html,/Signed-in Plus households can save selected plans/);
 assert.match(html,/A selection never counts as a completion/);
});
test('wheel shadow rings remain horizontally centered',()=>{
 assert.match(html,/\.wheel\{margin:0 auto;transform-origin:50% 50%;box-shadow:/);
 assert.match(html,/0 0 0 13px rgba\(245,214,184,\.66\)/);
});