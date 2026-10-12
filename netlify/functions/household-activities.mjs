import { getUser } from '@netlify/identity';
import { getDatabase } from '@netlify/database';
import moderation from '../../lib/activity-moderation.cjs';
const { moderateActivity } = moderation;
const respond=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(!['GET','POST'].includes(req.method))return respond({error:'method_not_allowed'},405);
 let user;
 try{user=await getUser();}catch{return respond({error:'authentication_unavailable'},503);}
 if(!user?.id)return respond({error:'authentication_required'},401);
 let db;
 try{db=getDatabase();}catch{return respond({error:'database_unavailable'},503);}
 try{
  const rows=await db.sql`SELECT h.id, s.status, s.current_period_end
   FROM households h LEFT JOIN subscriptions s ON s.household_id=h.id
   WHERE h.owner_subject=${user.id} LIMIT 1`;
  const row=rows[0];
  if(!row)return respond({error:'household_not_found'},403);
  // Never authorize on a client claim, Stripe redirect, or expired local status.
  const active=['active','trialing'].includes(row.status)&&
    row.current_period_end&&new Date(row.current_period_end).getTime()>Date.now();
  if(!active)return respond({error:'plus_required'},403);
  if(req.method==='GET'){
   const activities=await db.sql`SELECT id,name,category,duration_minutes,created_at
     FROM custom_activities WHERE household_id=${row.id} ORDER BY created_at DESC LIMIT 100`;
   return respond({activities});
  }
  const raw=await req.text();
  if(raw.length>4096)return respond({error:'payload_too_large'},413);
  let input;
  try{input=JSON.parse(raw);}catch{return respond({error:'invalid_json'},400);}
  const validation=moderateActivity(input);
  if(!validation.ok)return respond({error:validation.reason,policyVersion:validation.policyVersion},422);
  const count=await db.sql`SELECT count(*)::int AS count FROM custom_activities WHERE household_id=${row.id}`;
  if(count[0].count>=20)return respond({error:'activity_limit'},409);
  const saved=await db.sql`INSERT INTO custom_activities
   (household_id,name,category,duration_minutes,moderation_policy_version)
   VALUES (${row.id},${validation.value.name},${validation.value.category},20,${validation.policyVersion})
   RETURNING id,name,category,duration_minutes,created_at`;
  return respond({activity:saved[0]},201);
 }catch{return respond({error:'service_unavailable'},503);}
}
export const config={path:'/api/household/activities',method:['GET','POST']};
