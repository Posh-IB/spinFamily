'use strict';
const {test,mock}=require('node:test'),assert=require('node:assert/strict');
test('server session status uses verified Identity only and does not create a household',async()=>{
 let user=null,unavailable=false;
 mock.module('@netlify/identity',{namedExports:{getUser:async()=>{if(unavailable)throw Error('internal');return user;}}});
 const handler=(await import('../netlify/functions/account-session.mjs')).default;
 const req=method=>new Request('https://qa.example/api/account/session?subject=forged',{method});
 try{
  let r=await handler(req('GET'));assert.deepEqual(await r.json(),{authenticated:false,subject:null});assert.equal(r.headers.get('cache-control'),'no-store');
  user={id:'verified'};r=await handler(req('GET'));assert.deepEqual(await r.json(),{authenticated:true,subject:'verified'});
  assert.equal((await handler(req('POST'))).status,405);
  unavailable=true;r=await handler(req('GET'));assert.equal(r.status,503);assert.equal(JSON.stringify(await r.json()).includes('internal'),false);
 }finally{mock.restoreAll();}
});

