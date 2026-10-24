'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {activityId,completionFeedback,recommendationInput,displayResult}=require('../lib/recommendation-contract.cjs');
const catalog=require('../server/recommendation-catalog.json');
const now=new Date('2026-10-17T03:30:00Z'),activity={name:'Read a story together',category:'family'};
const row={client_plan_id:'32c92000-080a-4a1d-8714-d194246bdde9',plan_data:{schemaVersion:1,activities:[activity]},completed_at:'2026-10-17T03:00:00Z',completion_source:'explicit_caregiver'};
test('only authorized completed records cross the versioned feedback boundary using actual local date',()=>{
 const selected={...row,completed_at:null};
 const inferred={...row,completion_source:'inferred'};
 const r=completionFeedback([selected,inferred,row],'America/New_York',now);
 assert.equal(r.schemaVersion,1);assert.equal(r.records.length,1);
 assert.equal(r.records[0].date,'2026-10-16');
 assert.equal(r.records[0].activityIds[0],activityId(activity));
 assert.equal(JSON.stringify(r).includes(activity.name),false);
 assert.equal(activityId({...activity,name:'READ A STORY TOGETHER'}),activityId(activity));
});
test('client cannot inject history, household identity, target date, catalog or child profiles',()=>{
 for(const key of ['history','householdId','date','catalog','childProfile','feedback'])assert.throws(()=>recommendationInput([],'UTC',{[key]:[]},catalog,now));
 const r=recommendationInput([row],'America/New_York',{routines:[catalog[0].id]},catalog,now);
 assert.equal(r.context.date,'2026-10-17');assert.deepEqual(r.context.routines,[catalog[0].id]);
 assert.throws(()=>recommendationInput([],'UTC',{routines:['unknown']},catalog,now));
});
test('transport output must respect time, explicit veto, pinned routines and no fabricated activities',()=>{
 const a=catalog[0],input=recommendationInput([],'UTC',{},catalog,now);
 const result={schemaVersion:1,feedbackVersion:1,status:'OK',plans:[{entries:[{activityId:a.id,start:1080,end:1080+a.durationMin}]}]};
 assert.equal(displayResult(result,input).plans.length,1);
 assert.throws(()=>displayResult({...result,plans:[{entries:[{activityId:'fabricated',start:1080,end:1100}]}]},input));
 assert.throws(()=>displayResult(result,{...input,context:{...input.context,exclude:[a.id]}}));
 assert.throws(()=>displayResult(result,{...input,context:{...input.context,routines:[catalog[1].id]}}));
 assert.throws(()=>displayResult({...result,feedbackVersion:2},input));
});
test('private transport fails closed when missing, insecure or unsuccessful and refuses redirects',async()=>{
 const {requestPrivateSuggestions}=await import('../server/private-personalization.mjs');
 await assert.rejects(()=>requestPrivateSuggestions({}));
 await assert.rejects(()=>requestPrivateSuggestions({},{endpoint:'http://example.com/v1/next-day',token:'x'.repeat(32)}));
 let captured;const fetcher=async(url,opts)=>{captured=opts;return new Response('{}');};
 await requestPrivateSuggestions({test:true},{endpoint:'https://private.example/v1/next-day',token:'x'.repeat(32),fetcher});
 assert.equal(captured.redirect,'error');assert.equal(captured.headers.authorization,'Bearer '+'x'.repeat(32));
});


test('invalid private planning choices remain a client error instead of a service outage',async()=>{const {requestPrivateSuggestions}=await import('../server/private-personalization.mjs');await assert.rejects(()=>requestPrivateSuggestions({},{endpoint:'https://private.example/v1/next-day',token:'x'.repeat(32),fetcher:async()=>new Response('{}',{status:422})}),/invalid_planning_options/);});
