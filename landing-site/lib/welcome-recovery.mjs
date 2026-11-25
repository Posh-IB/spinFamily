// One-time, ledger-preserving recovery for the founder-authorized six-person batch.
import {randomUUID} from 'node:crypto';
import {config, keyFor, welcomeMessage, SITE_ID} from './pilot-welcome.mjs';
import {parseBatch, earlyMessage} from './welcome-batch.mjs';
const START=Date.parse('2026-11-25T14:40:00Z');
const END=Date.parse('2026-11-25T16:00:00Z');
export function recoveryStatus(r) {
 if(r.state==='outside_window')return 410;
 if(r.state==='wrong_context')return 403;
 if(r.state==='configuration_invalid'||r.state==='receipt_failed'||r.state==='ledger_unavailable')return 503;
 return r.state==='all_accepted'?200:409;
}
export async function recoverWelcome({env,siteId,deployContext,storeFactory,send,now=()=>Date.now(),log=()=>{}}){
 const report=r=>{log(r);return r};
 if(now()<START||now()>=END)return report({state:'outside_window'});
 if(siteId!==SITE_ID||deployContext!=='production')return report({state:'wrong_context'});
 const smtp=config(k=>k==='SITE_ID'?siteId:env(k)),entries=parseBatch(env('WELCOME_BATCH_20261125'));
 if(!smtp||!entries)return report({state:'configuration_invalid'});
 let store;
 try{store=await storeFactory()}catch{return report({state:'ledger_unavailable'})}
 async function state(key){
  const record=await store.get(key,{type:'json'});
  if(record===null)return 'missing';
  return record?.state==='smtp_accepted'?'accepted':record?.state==='claimed'?'claimed':record?.state==='uncertain'?'uncertain':'unknown';
 }
 let before;
 try{before=await Promise.all(entries.map(e=>state(keyFor(e.email))))}catch{return report({state:'ledger_unavailable'})}
 let newlyAccepted=0, attempted=0;
 await Promise.all(entries.map(async(e,i)=>{
  if(before[i]!=='missing')return;
  const key=keyFor(e.email);
  try{
   const claim=await store.setJSON(key,{state:'claimed',at:new Date(now()).toISOString(),version:1,batch:'20261125',recovery:true},{onlyIfNew:true});
   if(claim.modified!==true||!claim.etag)return;
   attempted++;
   try{
    const result=await send({...smtp,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:7000},e.group==='pilot'?welcomeMessage(e):earlyMessage(e));
    if(!Array.isArray(result.accepted)||!result.accepted.some(x=>typeof x==='string'&&x.toLowerCase()===e.email))throw Error('SMTP acceptance not confirmed');
   }catch{
    await store.setJSON(key,{state:'uncertain',at:new Date(now()).toISOString(),version:1,batch:'20261125',recovery:true},{onlyIfMatch:claim.etag}).catch(()=>{});
    return;
   }
   const done=await store.setJSON(key,{state:'smtp_accepted',at:new Date(now()).toISOString(),version:1,batch:'20261125',recovery:true},{onlyIfMatch:claim.etag});
   if(done.modified===true)newlyAccepted++;
  }catch{/* claim may have committed: never send without affirmative claim ownership */}
 }));
 let after;
 try{after=await Promise.all(entries.map(e=>state(keyFor(e.email))))}catch{return report({state:'ledger_unavailable',attempted,newlyAccepted})}
 const counts=Object.fromEntries(['accepted','claimed','uncertain','unknown','missing'].map(k=>[k,after.filter(x=>x===k).length]));
 const summary={state:counts.accepted===entries.length?'all_accepted':'reconciliation_required',total:entries.length,attempted,newlyAccepted,...counts,at:new Date(now()).toISOString()};
 try{const receipt=await store.setJSON('batch-receipts/20261125-recovery/'+randomUUID(),summary,{onlyIfNew:true});if(receipt.modified!==true)throw Error('receipt not stored')}
 catch{return report({...summary,state:'receipt_failed'})}
 return report(summary);
}
