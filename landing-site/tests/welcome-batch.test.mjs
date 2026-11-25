import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseBatch,runBatch,earlyMessage} from '../lib/welcome-batch.mjs';
import {SITE_ID,MAILBOX} from '../lib/pilot-welcome.mjs';
const entries=Array.from({length:6},(_,i)=>({group:i<3?'pilot':'early',firstName:'Parent'+i,email:'parent'+i+'@example.com'}));
const vals={SITE_ID,CONTEXT:'production',SMTP_HOST:'smtp.purelymail.com',SMTP_PORT:'465',SMTP_USER:MAILBOX,SMTP_PASSWORD:'fake',PILOT_EMAIL_FROM:MAILBOX,PILOT_EMAIL_REPLY_TO:MAILBOX,WELCOME_BATCH_20261125:JSON.stringify({version:1,entries})};
function harness(){const claims=new Map(),messages=[];return {messages,deps:{env:k=>vals[k],now:()=>Date.parse('2026-11-25T14:00:00Z'),storeFactory:()=>({async setJSON(k,v,o){if(o.onlyIfNew&&claims.has(k))return {modified:false};if(o.onlyIfMatch&&claims.get(k)?.etag!==o.onlyIfMatch)return {modified:false};let etag=v.state;claims.set(k,{...v,etag});return {modified:true,etag}}}),send:async(s,m)=>{messages.push(m);return {accepted:[m.to.address]}}}}}
test('batch validates six distinct recipients and groups',()=>{assert.equal(parseBatch(vals.WELCOME_BATCH_20261125).length,6);assert.equal(parseBatch(JSON.stringify({version:1,entries:[...entries.slice(0,5),entries[0]]})),null);});
test('outside window and preview do not send',async()=>{const h=harness();assert.equal((await runBatch({...h.deps,now:()=>Date.parse('2026-11-25T13:59:59Z')})).state,'outside_window');assert.equal((await runBatch({...h.deps,env:k=>k==='CONTEXT'?'deploy-preview':vals[k]})).state,'outside_window');assert.equal(h.messages.length,0)});
test('six individual messages, cohort-specific text and replay suppression',async()=>{const h=harness();const r=await runBatch(h.deps);assert.equal(r.accepted,6);assert.equal(h.messages.length,6);assert.equal(h.messages.filter(m=>m.subject.includes('Early SpinFamily')).length,3);assert.ok(h.messages.every(m=>m.text.includes('https://app.spinfamilyapp.com')&&m.replyTo===MAILBOX));assert.equal((await runBatch(h.deps)).duplicate,6);assert.equal(h.messages.length,6)});
test('early users not asked to register again',()=>assert.match(earlyMessage(entries[3]).text,/existing account/));
