import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import policy from '../../lib/product-events.cjs';
import {transaction} from '../../server/database.mjs';
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default async function handler(request){
 if(request.method!=='POST')return json({error:'method_not_allowed'},405);
 if(!security.sameOriginMutation(request))return json({error:'invalid_origin'},403);
 if(!(request.headers.get('content-type')||'').startsWith('application/json'))return json({error:'invalid_content_type'},415);
 if(Number(request.headers.get('content-length')||0)>4096)return json({error:'payload_too_large'},413);
 let user;try{user=await getUser();}catch{return json({error:'authentication_unavailable'},503);}
 if(!user?.id)return json({error:'authentication_required'},401);
 let raw;try{raw=await request.text();}catch{return json({error:'invalid_request'},400);}
 if(raw.length>4096)return json({error:'payload_too_large'},413);
 let parsed;try{parsed=policy.parseBatch(JSON.parse(raw));}catch{return json({error:'invalid_analytics_payload'},422);}
 try{
  return await transaction(async db=>{
   // Household ownership is determined from the authenticated server session.
   const household=(await db.query('SELECT id FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
   if(!household)return json({error:'household_not_found'},403);
   // Serialize each household's writes and cap ingestion per UTC day.
   const count=Number((await db.query("SELECT count(*)::int AS n FROM product_events WHERE household_id=$1 AND received_at>=date_trunc('day',now())",[household.id])).rows[0].n);
   if(count+parsed.events.length>policy.MAX_DAILY)return json({error:'analytics_rate_limited'},429);
   let accepted=0;
   for(const e of parsed.events){
    const out=await db.query(
     'INSERT INTO product_events(household_id,session_id,event_id,event_name,screen,active_ms,spins_before_plan) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (household_id,session_id,event_id) DO NOTHING',
     [household.id,parsed.sessionId,e.eventId,e.name,e.screen,e.activeMs,e.spinsBeforePlan]);
    accepted+=out.rowCount;
   }
   return json({accepted});
  });
 }catch{return json({error:'analytics_unavailable'},503);}
}
export const config={path:'/api/product/events',method:'POST'};