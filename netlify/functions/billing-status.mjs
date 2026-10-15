import {getUser} from '@netlify/identity';
import {transaction,environment} from '../../server/database.mjs';
import policy from '../../lib/billing-policy.cjs';
export default async function handler(req,context){
 const headers={'cache-control':'no-store'};
 try{
  const user=await getUser();
  if(!user?.id)return Response.json({error:'authentication_required'},{status:401,headers});
  const env=environment(context);
  const configured=policy.validConfig(env)&&env.SPINFAMILY_CHECKOUT_ORIGIN===new URL(req.url).origin;
  if(!configured)return Response.json({checkoutReady:false,portalReady:false},{headers});
  const linked=await transaction(async db=>(await db.query('SELECT s.provider_customer_id FROM subscriptions s JOIN households h ON h.id=s.household_id WHERE h.owner_subject=$1',[user.id])).rows[0]);
  return Response.json({checkoutReady:true,portalReady:Boolean(linked?.provider_customer_id)},{headers});
 }catch{return Response.json({checkoutReady:false,portalReady:false},{status:503,headers});}
}
export const config={path:'/api/billing/status',method:'GET'};
