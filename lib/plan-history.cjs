'use strict';
// Cross-product boundary derived from private WP2 event semantics, NOT its protected planner/ranker.
const moderation=require('./activity-moderation.cjs');
const CATEGORIES=new Set(['chore','outdoor','family','selfcare']);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowed=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));
function validTimezone(zone){
 if(typeof zone!=='string'||zone.length>64||zone.length<1)return false;
 try{new Intl.DateTimeFormat('en-US',{timeZone:zone}).format(new Date());return true;}catch{return false;}
}
function validateAcceptance(value){
 if(!allowed(value,['id','timezone','activities','anchorCategory'])||!UUID.test(value.id)||!validTimezone(value.timezone))
  return {ok:false,error:'invalid_plan'};
 if(!Array.isArray(value.activities)||value.activities.length<2||value.activities.length>12)
  return {ok:false,error:'invalid_plan'};
 const activities=[];
 let total=0;
 for(const item of value.activities){
  if(!allowed(item,['name','category','durationMinutes'])||
   !CATEGORIES.has(item.category)||!Number.isSafeInteger(item.durationMinutes)||
   item.durationMinutes<1||item.durationMinutes>120)return {ok:false,error:'invalid_plan'};
  const result=moderation.moderateActivity({name:item.name,category:item.category});
  if(!result.ok)return {ok:false,error:'blocked_activity'};
  total+=item.durationMinutes;
  activities.push({name:result.value.name,category:item.category,durationMinutes:item.durationMinutes});
 }
 if(total!==120||!CATEGORIES.has(value.anchorCategory)||
   !activities.some(x=>x.category===value.anchorCategory))return {ok:false,error:'invalid_plan'};
 return {ok:true,id:value.id.toLowerCase(),timezone:value.timezone,plan:{
  schemaVersion:1,source:'caregiver_selected_public_plan',anchorCategory:value.anchorCategory,activities
 }};
}
function localDay(timestamp,zone){
 if(!validTimezone(zone))throw new TypeError('Invalid household timezone');
 const date=timestamp instanceof Date?timestamp:new Date(timestamp);
 if(!Number.isFinite(date.getTime()))throw new TypeError('Invalid completion timestamp');
 const parts=new Intl.DateTimeFormat('en-US',{
  timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'
 }).formatToParts(date);
 const value=t=>parts.find(x=>x.type===t)?.value;
 return value('year')+'-'+value('month')+'-'+value('day');
}
const dayNum=day=>Date.parse(day+'T00:00:00.000Z')/86400000;
function completionStatistics(records,timezone,now=new Date()){
 if(!validTimezone(timezone))throw new TypeError('Invalid household timezone');
 if(!Array.isArray(records))throw new TypeError('Invalid history');
 const completed=records.filter(x=>x.completed_at||x.completedAt);
 const days=[...new Set(completed.map(x=>localDay(x.completed_at||x.completedAt,timezone)))].sort();
 let longest=0,run=0,previous=null;
 for(const day of days){
  const index=dayNum(day);
  run=previous!==null&&index===previous+1?run+1:1;
  longest=Math.max(longest,run);previous=index;
 }
 const today=dayNum(localDay(now,timezone));
 let current=0;
 if(previous!==null&&(previous===today||previous===today-1)){
  current=1;
  for(let i=days.length-2;i>=0;i--){
   if(dayNum(days[i])!==dayNum(days[i+1])-1)break;
   current++;
  }
 }
 return {
  acceptedPlans:records.length,completedPlans:completed.length,completedDays:days.length,
  currentDailyStreak:current,longestDailyStreakInSavedHistory:longest
 };
}
function serializeRecord(row){
 return {id:row.client_plan_id,status:row.completed_at?'completed':'accepted',
  acceptedAt:new Date(row.created_at).toISOString(),
  completedAt:row.completed_at?new Date(row.completed_at).toISOString():null,
  plan:row.plan_data};
}
module.exports={validateAcceptance,validTimezone,localDay,completionStatistics,serializeRecord,UUID};
