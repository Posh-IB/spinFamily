import security from '../../lib/request-security.cjs';
import { getUser } from '@netlify/identity';
import moderation from '../../lib/activity-moderation.cjs';
import customPlanning from '../../lib/custom-planning.cjs';
import {transaction} from '../../server/database.mjs';
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(!['GET','POST'].includes(req.method))return respond({error:'method_not_allowed'},405);
 if(req.method==='POST'&&!security.sameOriginMutation(req))return respond({error:'invalid_origin'},403);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 let validation,planning=null;
 if(req.method==='POST'){
  const raw=await req.text();
  if(raw.length>4096)return respond({error:'payload_too_large'},413);
  let input;
  try{input=JSON.parse(raw);}catch{return respond({error:'invalid_json'},400);}
  validation=moderation.moderateActivity(input);
  if(input?.planning!==undefined){try{planning=customPlanning.planningMetadata(input.planning);}catch{return respond({error:'invalid_planning_metadata'},422);}}
  if(!validation.ok)return respond({error:validation.reason,policyVersion:validation.policyVersion},422);
 }
 try{return await transaction(async db=>{
  const h=(await db.query('SELECT id FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
  if(!h)return respond({error:'household_not_found'},403);
  const s=(await db.query('SELECT * FROM subscriptions WHERE household_id=$1 FOR UPDATE',[h.id])).rows[0];
  const active=s?.verified_payment===true&&!s.terminal&&['active','trialing'].includes(s.status)&&s.current_period_end&&new Date(s.current_period_end)>new Date();
  if(!active)return respond({error:'plus_required'},403);
  if(req.method==='GET')return respond({activities:(await db.query('SELECT id,name,category,duration_minutes,planning_metadata,created_at FROM custom_activities WHERE household_id=$1 ORDER BY created_at DESC LIMIT 20',[h.id])).rows});
  const count=(await db.query('SELECT count(*)::int AS count FROM custom_activities WHERE household_id=$1',[h.id])).rows[0].count;
  if(count>=20)return respond({error:'activity_limit'},409);
  const saved=await db.query(`INSERT INTO custom_activities(household_id,name,category,duration_minutes,moderation_policy_version,planning_metadata)
    VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,name,category,duration_minutes,planning_metadata,created_at`,[h.id,validation.value.name,validation.value.category,planning?.durationMin??20,validation.policyVersion,planning?JSON.stringify(planning):null]);
  return respond({activity:saved.rows[0]},201);
 });}catch(error){if(error.code==='23514'&&error.message==='activity_limit')return respond({error:'activity_limit'},409);return respond({error:'service_unavailable'},503);}
}
export const config={path:'/api/household/activities',method:['GET','POST']};
