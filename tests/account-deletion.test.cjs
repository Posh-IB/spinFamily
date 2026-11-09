'use strict';
const {test,mock}=require('node:test'),assert=require('node:assert/strict');
const policy=require('../lib/account-deletion.cjs');

test('deletion requires an exact, single confirmation field',()=>{
 assert.deepEqual(policy.validate({confirm:'DELETE'}),{confirm:'DELETE'});
 for(const bad of [null,[],{},{confirm:'delete'},{confirm:'DELETE',extra:1},{confirm:true},'DELETE'])
  assert.throws(()=>policy.validate(bad));
});

test('a subscription that can still bill blocks deletion',()=>{
 assert.equal(policy.subscriptionBlocksDeletion(undefined),false);
 for(const status of ['active','trialing','past_due','unpaid','incomplete'])
  assert.equal(policy.subscriptionBlocksDeletion({status,terminal:false}),true,status);
 assert.equal(policy.subscriptionBlocksDeletion({status:'canceled',terminal:false}),false);
 assert.equal(policy.subscriptionBlocksDeletion({status:'active',terminal:true}),false);
});

test('delete endpoint: origin, auth, confirmation, Plus guard, cascade delete and login removal',async()=>{
 let user=null,sub=null,deleteFails=false,dbFails=false;const queries=[],removed=[];
 mock.module('@netlify/identity',{namedExports:{
  getUser:async()=>user,
  admin:{deleteUser:async id=>{if(deleteFails)throw Error('upstream');removed.push(id);}}
 }});
 mock.module('../server/database.mjs',{namedExports:{transaction:async fn=>{
  if(dbFails)throw Error('db down');
  return fn({query:async(sql,args)=>{queries.push([sql,args]);
   if(sql.startsWith('SELECT id FROM households'))return {rows:[{id:'hh1'}]};
   if(sql.startsWith('SELECT status,terminal FROM subscriptions'))return {rows:sub?[sub]:[]};
   return {rows:[]};
  }});
 }}});
 const handler=(await import('../netlify/functions/account-delete.mjs')).default;
 const req=(body,{origin='https://qa.example',method='POST',type='application/json'}={})=>new Request('https://qa.example/api/account/delete',
  {method,headers:{origin,'content-type':type},body:method==='POST'?JSON.stringify(body):undefined});
 const deletes=()=>queries.filter(([sql])=>sql.startsWith('DELETE FROM account_profiles'));
 try{
  assert.equal((await handler(req(null,{method:'GET'}))).status,405);
  assert.equal((await handler(req({confirm:'DELETE'},{origin:'https://evil.example'}))).status,403);
  assert.equal((await handler(req({confirm:'DELETE'}))).status,401);
  user={id:'parent_a'};
  assert.equal((await handler(req({confirm:'DELETE'},{type:'text/plain'}))).status,415);
  assert.equal((await handler(req({confirm:'yes'}))).status,422);
  assert.equal(deletes().length,0,'nothing deleted before a valid request');

  sub={status:'active',terminal:false};
  let r=await handler(req({confirm:'DELETE'}));
  assert.equal(r.status,409);assert.deepEqual(await r.json(),{error:'cancel_plus_first'});
  assert.equal(deletes().length,0,'active Plus blocks deletion');assert.deepEqual(removed,[]);

  sub={status:'canceled',terminal:true};
  r=await handler(req({confirm:'DELETE'}));
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{dataDeleted:true,loginRemoved:true});
  assert.deepEqual(deletes().at(-1)[1],['parent_a'],'deletes only the signed-in account');
  assert.deepEqual(removed,['parent_a']);
  assert.equal(r.headers.get('cache-control'),'no-store');

  deleteFails=true;
  r=await handler(req({confirm:'DELETE'}));
  assert.equal(r.status,207);assert.deepEqual(await r.json(),{dataDeleted:true,loginRemoved:false});

  deleteFails=false;dbFails=true;const before=removed.length;
  r=await handler(req({confirm:'DELETE'}));
  assert.equal(r.status,503);assert.equal(removed.length,before,'login is kept when family data could not be deleted');
 }finally{mock.restoreAll();}
});
