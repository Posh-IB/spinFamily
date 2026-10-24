'use strict';
const {createHash}=require('node:crypto');
const {localDay}=require('./plan-history.cjs');
const activityId=a=>'a_'+createHash('sha256').update(a.category+':'+a.name.normalize('NFKC').trim().toLowerCase()).digest('hex').slice(0,32);
const nextDay=day=>new Date(Date.parse(day+'T12:00:00Z')+86400000).toISOString().slice(0,10);
function completionFeedback(rows,timezone,asOf=new Date()){
 const records=rows.filter(r=>r.completed_at&&r.completion_source==='explicit_caregiver'&&r.plan_data?.schemaVersion===1)
 .map(r=>({id:r.client_plan_id,date:localDay(r.completed_at,timezone),
 activityIds:[...new Set(r.plan_data.activities.map(activityId))],state:'completed'}))
 .filter(r=>r.activityIds.length&&r.date<=localDay(asOf,timezone));
 return {schemaVersion:1,source:'authorized_household_completion',timezone,asOf:asOf.toISOString(),records};
}
function recommendationInput(rows,timezone,options,catalog,asOf=new Date()){
 const allowed=['start','end','energy','include','exclude','pins','routines','fixedEvents','schedule'];
 if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(k=>!allowed.includes(k)))throw Error('invalid_options');
 const known=new Set(catalog.map(a=>a.id));
 for(const key of ['include','exclude','pins','routines']){
  const ids=options[key]??[];
  if(!Array.isArray(ids)||ids.length>40||new Set(ids).size!==ids.length||ids.some(id=>!known.has(id)))throw Error('invalid_options');
 }
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.start??'18:00')||!/^([01]\d|2[0-3]):[0-5]\d$/.test(options.end??'20:00'))throw Error('invalid_options');
 if(options.energy!==undefined&&!['low','medium','high'].includes(options.energy))throw Error('invalid_options');
 if(options.fixedEvents!==undefined&&(!Array.isArray(options.fixedEvents)||options.fixedEvents.length>12))throw Error('invalid_options');
 let schedule;
 if(options.schedule!==undefined){
  const s=options.schedule;
  if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['selection','daypart','date','startLocal','endLocal'].includes(k))||!['today','tomorrow','future'].includes(s.selection)||!['default','custom','morning','afternoon','evening'].includes(s.daypart))throw Error('invalid_options');
  if(s.selection==='future'&&(typeof s.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.date)))throw Error('invalid_options');
  schedule={...s,timezone};
 }
 const contextOptions={...options};delete contextOptions.schedule;
 return {schemaVersion:1,...(schedule?{schedule}:{}),context:{schemaVersion:1,date:nextDay(localDay(asOf,timezone)),timezone,start:'18:00',end:'20:00',maxActivities:3,...contextOptions},catalog,feedback:completionFeedback(rows,timezone,asOf),seed:0};
}
// Verify the transport result without implementing private search or ranking.
function displayResult(result,input){
 if(result?.schemaVersion!==1||result.feedbackVersion!==1||!['OK','NO_FEASIBLE_PLAN','SEARCH_LIMIT_REACHED'].includes(result.status)||!Array.isArray(result.plans)||result.plans.length>3)throw Error('invalid_engine_response');
 const byId=new Map(input.catalog.map(a=>[a.id,a]));
 const minute=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
 let context=input.context;
 if(input.schedule){
  const w=result.window;
  if(!w||w.timezone!==input.feedback.timezone||w.selection!==input.schedule.selection||w.daypart!==input.schedule.daypart||!/^\d{4}-\d{2}-\d{2}$/.test(w.date)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)||minute(w.end)<=minute(w.start))throw Error('invalid_engine_response');
  context={...context,date:w.date,start:w.start,end:w.end};
 }
 const plans=result.plans.map(p=>{
  if(!Array.isArray(p.entries)||p.entries.length<1||p.entries.length>3)throw Error('invalid_engine_response');
  const seen=new Set();let last=minute(context.start);
  const activities=p.entries.map(e=>{
   const a=byId.get(e.activityId);
   if(!a||seen.has(a.id)||(context.exclude??[]).includes(a.id)||!Number.isInteger(e.start)||!Number.isInteger(e.end)||e.start<last||e.end>minute(context.end)||e.end-e.start!==a.durationMin+(a.prepMin??0)+(a.cleanupMin??0)+(a.transitionMin??0))throw Error('invalid_engine_response');
   for(const f of context.fixedEvents??[]){if(e.start<minute(f.end)+(f.bufferAfterMin??0)&&e.end>minute(f.start)-(f.bufferBeforeMin??0))throw Error('invalid_engine_response');}
   seen.add(a.id);last=e.end;return {id:a.id,name:a.title,category:a.category,start:e.start,end:e.end,durationMinutes:a.durationMin};
  });
  if([...(context.pins??[]),...(context.routines??[])].some(id=>!seen.has(id)))throw Error('invalid_engine_response');
  return {activities};
 });
 if((result.status==='OK')!==Boolean(plans.length))throw Error('invalid_engine_response');
 return {schemaVersion:1,date:context.date,timezone:context.timezone,...(result.window?{window:result.window}:{}),status:result.status,plans,historyCount:input.feedback.records.length,
 message:plans.length?'Based on caregiver-confirmed completed plans. Routines and your choices are respected.':'No suggestion fits these choices. Adjust the window or an explicit constraint if you choose.'};
}
module.exports={activityId,nextDay,completionFeedback,recommendationInput,displayResult};
