'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateAcceptance,localDay,completionStatistics}=require('../lib/plan-history.cjs');
const input=(id='32c92000-080a-4a1d-8714-d194246bdde9')=>({
 id,timezone:'America/New_York',anchorCategory:'family',
 activities:[{name:'Read a story together',category:'family',durationMinutes:45},
  {name:'Visit the park',category:'outdoor',durationMinutes:45},
  {name:'Quiet reading',category:'selfcare',durationMinutes:30}]
});
test('acceptance is explicit, bounded, moderated and totals two hours',()=>{
 const parsed=validateAcceptance(input());
 assert.equal(parsed.ok,true);
 assert.equal(parsed.plan.schemaVersion,1);
 assert.equal(parsed.plan.activities.reduce((n,a)=>n+a.durationMinutes,0),120);
 assert.equal(Object.hasOwn(parsed.plan,'completed'),false);
 assert.equal(validateAcceptance({...input(),timezone:'Mars/Phobos'}).ok,false);
 assert.equal(validateAcceptance({...input(),activities:[{name:'Family',category:'family',durationMinutes:120}]}).ok,false);
 assert.equal(validateAcceptance({...input(),anchorCategory:'chore'}).ok,false);
 assert.equal(validateAcceptance({...input(),activities:[{name:'f u c k',category:'family',durationMinutes:45},...input().activities.slice(1)]}).ok,false);
});
test('household days derive from actual explicit completion timestamp',()=>{
 assert.equal(localDay('2026-10-17T03:30:00.000Z','America/New_York'),'2026-10-16');
 assert.equal(localDay('2026-10-17T04:30:00.000Z','America/New_York'),'2026-10-17');
});
test('acceptances do not count toward completion or streaks',()=>{
 const records=[
  {created_at:'2026-10-15T18:00:00Z',completed_at:'2026-10-15T23:00:00Z'},
  {created_at:'2026-10-16T18:00:00Z',completed_at:null}
 ];
 assert.deepEqual(completionStatistics(records,'America/New_York',new Date('2026-10-16T19:00:00Z')),
 {acceptedPlans:2,completedPlans:1,completedDays:1,completedToday:false,currentDailyStreak:1,longestDailyStreakInSavedHistory:1});
});
test('duplicate completions same day yield one streak day; yesterday continues, gap resets',()=>{
 const finished=days=>days.map(x=>({completedAt:x,created_at:x}));
 const a=finished(['2026-10-13T16:00:00Z','2026-10-14T16:00:00Z',
  '2026-10-14T18:00:00Z','2026-10-15T16:00:00Z']);
 const state=completionStatistics(a,'UTC',new Date('2026-10-16T16:00:00Z'));
 assert.equal(state.completedPlans,4);
 assert.equal(state.completedDays,3);
 assert.equal(state.completedToday,false);
 assert.equal(state.currentDailyStreak,3);
 assert.equal(state.longestDailyStreakInSavedHistory,3);
 assert.equal(completionStatistics(a,'UTC',new Date('2026-10-18T16:00:00Z')).currentDailyStreak,0);
});
