'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parseBatch,MAX_BATCH,MAX_DAILY}=require('../lib/product-events.cjs');
const sid='123e4567-e89b-42d3-a456-426614174000';
const eid='123e4567-e89b-42d3-a456-426614174001';
const valid={sessionId:sid,events:[{eventId:eid,name:'plan_accepted',screen:'home',spinsBeforePlan:3}]};
test('first-party analytics accepts only listed minimal event fields',()=>{
 assert.deepEqual(parseBatch(valid),{sessionId:sid,events:[{eventId:eid,name:'plan_accepted',screen:'home',spinsBeforePlan:3,activeMs:null}]});
});
test('event payload rejects user identity, text and metadata',()=>{
 for(const property of ['email','activityName','memberName','notes','profileId','paymentDetails']){
  const p=structuredClone(valid);p.events[0][property]='private information';
  assert.throws(()=>parseBatch(p),/invalid_analytics_payload/);
 }
 assert.throws(()=>parseBatch({...valid,identitySubject:'user'}),/invalid_analytics_payload/);
});
test('event values must be bounded and eligible for that event',()=>{
 for(const event of [
  {name:'password_submitted'},
  {screen:'children'},
  {spinsBeforePlan:-1},
  {spinsBeforePlan:256},
  {activeMs:500},
  {eventId:'wrong'},
  {name:'wheel_spun',spinsBeforePlan:3}
 ]){
  const p=structuredClone(valid);p.events[0]={...p.events[0],...event};
  assert.throws(()=>parseBatch(p),/invalid_analytics_payload/);
 }
 assert.deepEqual(parseBatch({sessionId:sid,events:[{eventId:eid,name:'screen_exited',screen:'guide',activeMs:18000}]}).events[0].activeMs,18000);
});
test('batched events require unique IDs and a strict batch limit',()=>{
 assert.ok(MAX_DAILY>MAX_BATCH);
 assert.throws(()=>parseBatch({sessionId:sid,events:[]}),/invalid_analytics_payload/);
 assert.throws(()=>parseBatch({sessionId:sid,events:[valid.events[0],valid.events[0]]}),/invalid_analytics_payload/);
 assert.throws(()=>parseBatch({sessionId:sid,events:Array.from({length:MAX_BATCH+1},(_,i)=>({...valid.events[0],eventId:'123e4567-e89b-42d3-a456-'+String(i).padStart(12,'0')}))}),/invalid_analytics_payload/);
});
