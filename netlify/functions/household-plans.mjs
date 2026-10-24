import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import historyPolicy from '../../lib/plan-history.cjs';
import paging from '../../lib/history-cursor.cjs';
import {transaction} from '../../server/database.mjs';
const {validateAcceptance,UUID,serializeRecord}=historyPolicy;
const {HISTORY_PAGE_SIZE,HISTORY_HARD_CAP,encodeCursor,decodeCursor}=paging;
const response=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const fail=(reason,status)=>response({error:reason},status);
const selectRecords=async(db,id,cursor=null)=>{
 const params=[id];let after='';
 if(cursor){params.push(cursor.createdAt,cursor.id);after=' AND (created_at, id) < ($2::timestamptz, $3::uuid)';}
 const rows=(await db.query('SELECT id,client_plan_id,plan_data,created_at,completed_at FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL'+after+' ORDER BY created_at DESC,id DESC LIMIT '+(HISTORY_PAGE_SIZE+1),params)).rows;
 const hasMore=rows.length>HISTORY_PAGE_SIZE,page=rows.slice(0,HISTORY_PAGE_SIZE);
 return {rows:page,nextCursor:hasMore?encodeCursor(page.at(-1)):null};
};
const aggregateProgress=async(db,id,timezone)=>{
 const rows=(await db.query("SELECT (completed_at AT TIME ZONE $2)::date AS day FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL AND completed_at IS NOT NULL AND completion_source='explicit_caregiver' GROUP BY day ORDER BY day ASC",[id,timezone])).rows;
 const totals=(await db.query('SELECT count(*)::int AS accepted,count(completed_at)::int AS completed FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL',[id])).rows[0];
 const days=rows.map(r=>typeof r.day==='string'?r.day:new Date(r.day).toISOString().slice(0,10));
 const today=historyPolicy.localDay(new Date(),timezone),dayNum=d=>Date.parse(d+'T00:00:00Z')/86400000;
 let longest=0,run=0,prev=null;
 for(const d of days){const n=dayNum(d);run=prev!==null&&n===prev+1?run+1:1;longest=Math.max(longest,run);prev=n;}
 let current=0,n=dayNum(today);
 if(prev!==null&&(prev===n||prev===n-1)){current=1;for(let i=days.length-2;i>=0;i--){if(dayNum(days[i])!==dayNum(days[i+1])-1)break;current++;}}
 return {acceptedPlans:totals.accepted,completedPlans:totals.completed,completedDays:days.length,completedToday:days.includes(today),currentDailyStreak:current,longestDailyStreakInSavedHistory:longest};
};
export default async function handler(req){
 if(!['GET','POST'].includes(req.method))return fail('method_not_allowed',405);
 if(req.method==='POST'&&!security.sameOriginMutation(req))return fail('invalid_origin',403);
 let user;
 try{user=await getUser();}catch{return fail('authentication_unavailable',503);}
 if(!user?.id)return fail('authentication_required',401);
 let data;
 let cursor=null;
 if(req.method==='GET'){
  const uri=new URL(req.url);if([...uri.searchParams.keys()].some(k=>k!=='cursor'))return fail('invalid_query',400);
  try{cursor=decodeCursor(uri.searchParams.get('cursor'));}catch{return fail('invalid_history_cursor',422);}
 }
 if(req.method==='POST'){
  const size=Number(req.headers.get('content-length')||0);
  if(size>4096)return fail('payload_too_large',413);
  const raw=await req.text();
  if(raw.length>4096)return fail('payload_too_large',413);
  try{data=JSON.parse(raw);}catch{return fail('invalid_json',400);}
  if(!data||typeof data!=='object'||Array.isArray(data))return fail('invalid_request',400);
  if(!['accept','complete','delete'].includes(data.action))return fail('invalid_action',400);
  if(data.action==='accept'){
   const parsed=validateAcceptance(data.plan);
   if(!parsed.ok)return fail(parsed.error,422);
   data= {action:'accept',parsed};
  }else{
   if(!UUID.test(data.id||''))return fail('invalid_plan_id',422);
   data={action:data.action,id:data.id.toLowerCase()};
  }
 }
 try{return await transaction(async db=>{
  // Registration and Free progress never require a Stripe customer or subscription.
  await db.query('INSERT INTO account_profiles(identity_subject) VALUES($1) ON CONFLICT DO NOTHING',[user.id]);
  const hh=(await db.query('INSERT INTO households(owner_subject) VALUES($1) ON CONFLICT(owner_subject) DO UPDATE SET owner_subject=EXCLUDED.owner_subject RETURNING id,history_timezone',[user.id])).rows[0];
  if(req.method==='GET'){
   const page=await selectRecords(db,hh.id,cursor);
   const timezone=hh.history_timezone||'UTC';
   return response({timezone,records:page.rows.map(serializeRecord),nextCursor:page.nextCursor,progress:await aggregateProgress(db,hh.id,timezone)});
  }
  if(data.action==='accept'){
   const p=data.parsed;
   if(hh.history_timezone&&hh.history_timezone!==p.timezone)return fail('household_timezone_mismatch',409);
   const previous=(await db.query('SELECT id,(plan_data=$3::jsonb) AS same FROM saved_plans WHERE household_id=$1 AND client_plan_id=$2',[hh.id,p.id,JSON.stringify(p.plan)])).rows[0];
   if(previous){
    if(!previous.same)return fail('plan_id_conflict',409);
   }else{
    const count=(await db.query('SELECT count(*)::int AS n FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL',[hh.id])).rows[0].n;
    if(count>=HISTORY_HARD_CAP)return fail('history_capacity_reached',409);
    await db.query('INSERT INTO saved_plans(household_id,client_plan_id,plan_data) VALUES($1,$2,$3::jsonb)',[hh.id,p.id,JSON.stringify(p.plan)]);
   }
   if(!hh.history_timezone)await db.query('UPDATE households SET history_timezone=$2 WHERE id=$1',[hh.id,p.timezone]);
  }
  if(data.action==='complete'){
   // A completion is a separate caregiver action. Timestamp is server-owned.
   const updated=await db.query("UPDATE saved_plans SET completed_at=now(),completion_source='explicit_caregiver' WHERE household_id=$1 AND client_plan_id=$2 AND completed_at IS NULL RETURNING id",[hh.id,data.id]);
   if(!updated.rowCount){
    const existing=(await db.query('SELECT id FROM saved_plans WHERE household_id=$1 AND client_plan_id=$2',[hh.id,data.id])).rows[0];
    if(!existing)return fail('acceptance_required',404);
   }
  }
  if(data.action==='delete'){
   const deleted=await db.query('DELETE FROM saved_plans WHERE household_id=$1 AND client_plan_id=$2 RETURNING id',[hh.id,data.id]);
   if(!deleted.rowCount)return fail('record_not_found',404);
  }
  const page=await selectRecords(db,hh.id);
  const timezone=hh.history_timezone||data.parsed?.timezone||'UTC';
  return response({timezone,records:page.rows.map(serializeRecord),nextCursor:page.nextCursor,progress:await aggregateProgress(db,hh.id,timezone)});
 });}catch{return fail('history_unavailable',503);}
}
export const config={path:'/api/household/plans',method:['GET','POST']};
