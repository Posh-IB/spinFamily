import {transaction} from '../../server/database.mjs';
// Strict rolling retention: raw interaction events expire after 30 days.
// Aggregate reports should be calculated separately, never retaining identity.
export default async function handler(){
 try{
  await transaction(db=>db.query("DELETE FROM product_events WHERE received_at < now() - interval '30 days'"));
  return new Response(null,{status:204});
 }catch{return Response.json({error:'retention_unavailable'},{status:503});}
}
export const config={schedule:'0 5 * * *'};