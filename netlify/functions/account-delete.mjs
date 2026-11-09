import {getUser,admin} from '@netlify/identity';
import security from '../../lib/request-security.cjs';
import policy from '../../lib/account-deletion.cjs';
import {transaction} from '../../server/database.mjs';
const reply=(data,status=200)=>Response.json(data,{status,headers:{'cache-control':'no-store'}});
export default async function handler(req){
 if(req.method!=='POST')return reply({error:'method_not_allowed'},405);
 if(!security.sameOriginMutation(req))return reply({error:'invalid_origin'},403);
 let user;
 try{user=await getUser();}catch{return reply({error:'authentication_unavailable'},503);}
 if(!user?.id)return reply({error:'authentication_required'},401);
 if(!(req.headers.get('content-type')||'').startsWith('application/json'))return reply({error:'invalid_content_type'},415);
 if(Number(req.headers.get('content-length')||0)>128)return reply({error:'payload_too_large'},413);
 let raw;try{raw=await req.text();}catch{return reply({error:'invalid_request'},422);}
 if(raw.length>128)return reply({error:'payload_too_large'},413);
 try{policy.validate(JSON.parse(raw));}catch{return reply({error:'invalid_request'},422);}
 // 1. Family data first: every table cascades from account_profiles, so one delete removes the
 //    household, members, plans, custom activities and billing records together.
 try{
  const outcome=await transaction(async db=>{
   const hh=(await db.query('SELECT id FROM households WHERE owner_subject=$1 FOR UPDATE',[user.id])).rows[0];
   if(hh){
    const sub=(await db.query('SELECT status,terminal FROM subscriptions WHERE household_id=$1',[hh.id])).rows[0];
    if(policy.subscriptionBlocksDeletion(sub))return 'cancel_plus_first';
   }
   await db.query('DELETE FROM account_profiles WHERE identity_subject=$1',[user.id]);
   return 'deleted';
  });
  if(outcome==='cancel_plus_first')return reply({error:'cancel_plus_first'},409);
 }catch{return reply({error:'account_deletion_unavailable'},503);}
 // 2. Then the login itself. If this step fails the family data is already gone, so say so plainly.
 try{
  await admin.deleteUser(user.id);
  return reply({dataDeleted:true,loginRemoved:true});
 }catch{
  return reply({dataDeleted:true,loginRemoved:false},207);
 }
}
export const config={path:'/api/account/delete',method:'POST'};
