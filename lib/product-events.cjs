'use strict';
// Product intelligence boundary: event names and numeric measures only.
// No names, emails, free-form text, payment details or child profile data.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENTS=new Set(['session_started','screen_viewed','screen_exited','wheel_spun','plan_viewed','plan_accepted','plan_completed','custom_activity_created','upgrade_clicked','checkout_started','checkout_canceled']);
const SCREENS=new Set(['home','activities','family','guide','more','checkout']);
const MAX_BATCH=12;
const MAX_DAILY=750;
function invalid(){throw new TypeError('invalid_analytics_payload');}
function fields(obj,allowed){
 if(!obj||typeof obj!=='object'||Array.isArray(obj)||Object.keys(obj).some(k=>!allowed.includes(k)))invalid();
}
function parseBatch(payload){
 fields(payload,['sessionId','events']);
 if(typeof payload.sessionId!=='string'||!UUID.test(payload.sessionId))invalid();
 if(!Array.isArray(payload.events)||payload.events.length===0||payload.events.length>MAX_BATCH)invalid();
 const used=new Set();
 const events=payload.events.map(e=>{
  fields(e,['eventId','name','screen','activeMs','spinsBeforePlan']);
  if(typeof e.eventId!=='string'||!UUID.test(e.eventId)||used.has(e.eventId.toLowerCase()))invalid();
  used.add(e.eventId.toLowerCase());
  if(!EVENTS.has(e.name)||!SCREENS.has(e.screen))invalid();
  if(e.activeMs!==undefined && (e.name!=='screen_exited'||!Number.isSafeInteger(e.activeMs)||e.activeMs<0||e.activeMs>300000))invalid();
  if(e.spinsBeforePlan!==undefined&&(e.name!=='plan_accepted'||!Number.isSafeInteger(e.spinsBeforePlan)||e.spinsBeforePlan<0||e.spinsBeforePlan>255))invalid();
  return {eventId:e.eventId.toLowerCase(),name:e.name,screen:e.screen,activeMs:e.activeMs??null,spinsBeforePlan:e.spinsBeforePlan??null};
 });
 return {sessionId:payload.sessionId.toLowerCase(),events};
}
module.exports={parseBatch,EVENTS,SCREENS,MAX_BATCH,MAX_DAILY};