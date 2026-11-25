import { config, keyFor, welcomeMessage, MAILBOX } from './pilot-welcome.mjs';
const START=Date.parse('2026-11-25T14:00:00Z');
const END=Date.parse('2026-11-25T14:20:00Z');
const expected={pilot:3,early:3};
export function parseBatch(raw) {
 let b;try{b=JSON.parse(raw)}catch{return null}
 if(b?.version!==1||!Array.isArray(b.entries)||b.entries.length!==6)return null;
 const counts={pilot:0,early:0}, seen=new Set();
 for(const e of b.entries){
  if(!e||!Object.hasOwn(expected,e.group)||typeof e.firstName!=='string'||typeof e.email!=='string')return null;
  if(!e.firstName.trim()||e.firstName.length>60||/[\u0000-\u001f\u007f<>]/.test(e.firstName)||e.email!==e.email.trim().toLowerCase()||e.email.length>120||!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+$/i.test(e.email)||e.email.includes('..')||seen.has(e.email))return null;
  seen.add(e.email);counts[e.group]++;
 }
 return counts.pilot===3&&counts.early===3?b.entries:null;
}
export function earlyMessage(e){
 const text=`Hi ${e.firstName},\n\nThank you for being one of our earliest SpinFamily users!\n\nYour participation is important as we continue developing SpinFamily into a valuable resource for parents and their families.\n\nWe've officially begun recruiting families for our pilot program, and we'd love for you to continue being part of the SpinFamily experience.\n\nWhat's coming soon?\n- Additional information about the SpinFamily pilot program.\n- A short survey to help us better understand your experience.\n- Additional SpinFamily Plus features.\n- Continued improvements based on feedback from parents like you.\n\nIn the meantime, continue exploring SpinFamily using your existing account:\nhttps://app.spinfamilyapp.com\n\nWe welcome your feedback, suggestions and ideas. Simply reply to this email whenever you have something you'd like to share or to opt out of pilot emails.\n\nThank you for supporting SpinFamily from the beginning.\n\nThe SpinFamily Team\nPlan it. Share it. Live it.\nA Rootlayer Software LLC product.`;
 return {from:{name:'SpinFamily',address:MAILBOX},replyTo:MAILBOX,to:{address:e.email,name:''},subject:'Thank You for Being an Early SpinFamily User!',text,disableFileAccess:true,disableUrlAccess:true};
}
export async function runBatch({env,storeFactory,send,now=()=>Date.now(),log=()=>{}}){
 const time=now();if(time<START||time>=END||env('CONTEXT')!=='production')return {state:'outside_window'};
 const smtp=config(env),entries=parseBatch(env('WELCOME_BATCH_20261125'));
 if(!smtp||!entries){log({state:'configuration_invalid'});return {state:'configuration_invalid'};}
 const store=await storeFactory();
 const results=await Promise.all(entries.map(async e=>{
  const key=keyFor(e.email);
  try{
   const claim=await store.setJSON(key,{state:'claimed',at:new Date(now()).toISOString(),version:1,batch:'20261125'},{onlyIfNew:true});
   if(!claim.modified)return 'duplicate';
   if(!claim.etag)return 'uncertain';
   try{
    const result=await send({...smtp,connectionTimeout:5000,greetingTimeout:5000,socketTimeout:7000},e.group==='pilot'?welcomeMessage(e):earlyMessage(e));
    if(!Array.isArray(result.accepted)||!result.accepted.some(x=>typeof x==='string'&&x.toLowerCase()===e.email))throw Error('SMTP not accepted');
   }catch{
    await store.setJSON(key,{state:'uncertain',at:new Date(now()).toISOString(),version:1,batch:'20261125'},{onlyIfMatch:claim.etag}).catch(()=>{});
    return 'uncertain';
   }
   const done=await store.setJSON(key,{state:'smtp_accepted',at:new Date(now()).toISOString(),version:1,batch:'20261125'},{onlyIfMatch:claim.etag});
   return done.modified?'smtp_accepted':'uncertain';
  }catch{return 'uncertain'}
 }));
 const summary={state:'finished',accepted:results.filter(x=>x==='smtp_accepted').length,duplicate:results.filter(x=>x==='duplicate').length,uncertain:results.filter(x=>x==='uncertain').length};
 log(summary);return summary;
}
