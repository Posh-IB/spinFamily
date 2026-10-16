import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import historyPolicy from '../../lib/plan-history.cjs';
import {transaction} from '../../server/database.mjs';
const {validateAcceptance,UUID,completionStatistics,serializeRecord}=historyPolicy;
const response=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const fail=(reason,status)=>response({error:reason},status);
const isActive=s=>s?.verified_payment===true&&!s.terminal&&
 ['active','trialing'].includes(s.status)&&s.current_period_end&&new Date(s.current_period_end)>new Date();
const selectRecords=async(db,id)=>(await db.query(
 'SELECT client_plan_id,plan_data,created_at,completed_at FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL ORDER BY created_at DESC LIMIT 100',[id])).rows;
export default async function handler(req){
 if(!['GET','POST'].includes(req.method))return fail('method_not_allowed',405);
 if(req.method==='POST'&&!security.sameOriginMutation(req))return fail('invalid_origin',403);
 let user;
 try{user=await getUser();}catch{return fail('authentication_unavailable',503);}
 if(!user?.id)return fail('authentication_required',401);
 let data;
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
  const hh=(await db.query('SELECT id,history_timezone FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
  if(!hh)return fail('household_not_found',403);
  const s=(await db.query('SELECT status,verified_payment,terminal,current_period_end FROM subscriptions WHERE household_id=$1 FOR UPDATE',[hh.id])).rows[0];
  if(!isActive(s))return fail('plus_required',403);
  if(req.method==='GET'){
   const rows=await selectRecords(db,hh.id);
   const timezone=hh.history_timezone||'UTC';
   return response({timezone,records:rows.map(serializeRecord),progress:completionStatistics(rows,timezone)});
  }
  if(data.action==='accept'){
   const p=data.parsed;
   if(hh.history_timezone&&hh.history_timezone!==p.timezone)return fail('household_timezone_mismatch',409);
   const previous=(await db.query('SELECT id,(plan_data=$3::jsonb) AS same FROM saved_plans WHERE household_id=$1 AND client_plan_id=$2',[hh.id,p.id,JSON.stringify(p.plan)])).rows[0];
   if(previous){
    if(!previous.same)return fail('plan_id_conflict',409);
   }else{
    const count=(await db.query('SELECT count(*)::int AS n FROM saved_plans WHERE household_id=$1 AND client_plan_id IS NOT NULL',[hh.id])).rows[0].n;
    if(count>=100)return fail('history_capacity_reached',409);
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
  const rows=await selectRecords(db,hh.id);
  const timezone=hh.history_timezone||data.parsed?.timezone||'UTC';
  return response({timezone,records:rows.map(serializeRecord),progress:completionStatistics(rows,timezone)});
 });}catch{return fail('history_unavailable',503);}
}
export const config={path:'/api/household/plans',method:['GET','POST']};
