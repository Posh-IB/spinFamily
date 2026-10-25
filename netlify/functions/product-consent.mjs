import {getUser} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import {transaction} from '../../server/database.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export default async function handler(request){
 if(!['GET','POST'].includes(request.method))return reply({error:'method_not_allowed'},405);
 if(request.method==='POST'&&!security.sameOriginMutation(request))return reply({error:'invalid_origin'},403);
 let user;try{user=await getUser();}catch{return reply({error:'authentication_unavailable'},503);}
 if(!user?.id)return reply({error:'authentication_required'},401);
 let enabled;
 if(request.method==='POST'){
  if(!(request.headers.get('content-type')||'').startsWith('application/json'))return reply({error:'invalid_content_type'},415);
  if(Number(request.headers.get('content-length')||0)>128)return reply({error:'invalid_payload'},422);
  let raw;try{raw=await request.text();}catch{return reply({error:'invalid_payload'},422);}
  if(raw.length>128)return reply({error:'invalid_payload'},422);
  let data;try{data=JSON.parse(raw);}catch{return reply({error:'invalid_payload'},422);}
  if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==1||typeof data.enabled!=='boolean')return reply({error:'invalid_payload'},422);
  enabled=data.enabled;
 }
 try{return await transaction(async db=>{
  const row=(await db.query('SELECT id,analytics_opt_in FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
  if(!row)return reply({enabled:false});
  if(request.method==='POST'){
   await db.query('UPDATE households SET analytics_opt_in=$2 WHERE id=$1',[row.id,enabled]);
   if(!enabled)await db.query('DELETE FROM product_events WHERE household_id=$1',[row.id]);
   return reply({enabled});
  }
  return reply({enabled:row.analytics_opt_in===true});
 });}catch{return reply({error:'analytics_unavailable'},503);}
}
export const config={path:'/api/product/consent',method:['GET','POST']};
