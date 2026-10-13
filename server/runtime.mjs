import {getConnectionString} from '@netlify/database';
import {getUser} from '@netlify/identity';
import pg from 'pg';
import Stripe from 'stripe';
import {createPlusService,BoundaryError} from './plus-service.mjs';
let pool;
export const env=name=>globalThis.Netlify?.env.get(name);
export function service(context){
 if(!['deploy-preview','branch-deploy'].includes(context?.deploy?.context)||env('SPINFAMILY_ISOLATION_VERIFIED')!=='true')throw new BoundaryError('isolated_preview_required',503);
 const key=env('SPINFAMILY_STRIPE_TEST_KEY');if(!/^(sk|rk)_test_/.test(key||''))throw new BoundaryError('sandbox_key_required',503);
 pool??=new pg.Pool({connectionString:getConnectionString(),max:3});
 return createPlusService({config:{mode:'test',monthly:{price:env('SPINFAMILY_TEST_MONTHLY_PRICE'),linkId:env('SPINFAMILY_TEST_MONTHLY_LINK_ID'),url:env('SPINFAMILY_TEST_MONTHLY_LINK_URL')},annual:{price:env('SPINFAMILY_TEST_ANNUAL_PRICE'),linkId:env('SPINFAMILY_TEST_ANNUAL_LINK_ID'),url:env('SPINFAMILY_TEST_ANNUAL_LINK_URL')}},stripe:new Stripe(key,{apiVersion:'2026-08-26.dahlia'}),transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}});
}
export const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function authenticated(req,fn,context){
 try{
  if(req.method!=='GET'&&req.headers.get('origin')!==new URL(req.url).origin)throw new BoundaryError('origin_mismatch',403);
  const user=await getUser();if(!user?.id)throw new BoundaryError('authentication_required',401);
  return json(await fn(service(context),user.id));
 }catch(e){return json({error:e instanceof BoundaryError?e.message:'service_unavailable'},e.status||503);}
}
export async function body(req){const raw=await req.text();if(Buffer.byteLength(raw)>4096)throw new BoundaryError('payload_too_large',413);try{return JSON.parse(raw);}catch{throw new BoundaryError('invalid_json',400);}}
