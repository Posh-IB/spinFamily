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
 assert.match(html,/Signed-in Free and Plus households can save selected plans/);
 assert.match(html,/A selection never counts as a completion/);
 assert.match(html,/Guest selections are not saved; create a Free account or sign in to save future plans and completion history/);
 assert.doesNotMatch(html,/sign in to Plus to keep completion history/i);
});
test('wheel shadow rings remain horizontally centered',()=>{
 assert.match(html,/\.wheel\{margin:0 auto;transform-origin:50% 50%;box-shadow:/);
 assert.match(html,/0 0 0 13px rgba\(245,214,184,\.66\)/);
});
test('Free registration and sign in remain available outside all page views',()=>{
 assert.match(html,/<section class="account-bar"/);
 assert.match(html,/id="accountOpenSignIn"/);
 assert.match(html,/id="accountOpenCreate"/);
 assert.match(html,/id="plusAccountPanel"/);
 assert.match(html,/id="plusAuthForm"/);
 const panel=html.indexOf('id="plusAccountPanel"');
 const home=html.indexOf('id="spinPage"');
 assert.ok(panel>0&&panel<home,'global account access appears before page navigation views');
 assert.match(html,/Free account completion history/);
});
