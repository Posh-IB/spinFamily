'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {handleCustomActivity}=require('../lib/household-boundary.cjs');
const event=(name='Read a story')=>({httpMethod:'POST',body:JSON.stringify({name,category:'family'})});
const context={clientContext:{user:{sub:'identity-user-A'}}};
const deps=()=>{
 const calls=[];
 return {calls,entitlements:{householdForSubject:async subject=>{calls.push(['lookup',subject]);return {id:'house-A'};},hasActivePlus:async id=>{calls.push(['plus',id]);return true;}},activities:{createForHousehold:async(id,record)=>{calls.push(['create',id]);return {id:'act-A',...record};}}};
};
test('no anonymous write even if body contains forged user',async()=>{
 const d=deps(),res=await handleCustomActivity(event(),{},d);
 assert.equal(res.statusCode,401);assert.equal(d.calls.length,0);
});
test('fail closed when adapters absent',async()=>assert.equal((await handleCustomActivity(event(),context)).statusCode,503));
test('moderation before storage',async()=>{
 const d=deps(),res=await handleCustomActivity(event('f u c k'),context,d);
 assert.equal(res.statusCode,422);assert.equal(d.calls.length,0);
});
test('subject derived only from verified Netlify context',async()=>{
 const d=deps(),e=event();e.body=JSON.stringify({name:'Read a story',category:'family',userId:'attacker',householdId:'other'});
 const res=await handleCustomActivity(e,context,d);
 assert.equal(res.statusCode,201);assert.deepEqual(d.calls.slice(0,2),[['lookup','identity-user-A'],['plus','house-A']]);
 assert.equal(d.calls[2][1],'house-A');
});
test('no write without Plus',async()=>{
 const d=deps();d.entitlements.hasActivePlus=async()=>false;
 const res=await handleCustomActivity(event(),context,d);
 assert.equal(res.statusCode,403);assert.equal(d.calls.some(x=>x[0]==='create'),false);
});
test('reject oversized payload',async()=>assert.equal((await handleCustomActivity({httpMethod:'POST',body:'x'.repeat(4097)},context,deps())).statusCode,413));
test('storage failure does not expose internals',async()=>{
 const d=deps();d.activities.createForHousehold=async()=>{throw Error('db secret');};
 const res=await handleCustomActivity(event(),context,d);
 assert.equal(res.statusCode,503);assert.equal(res.body.includes('db secret'),false);
});
