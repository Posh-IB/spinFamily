import pg from 'pg';
import { getConnectionString } from '@netlify/database';
let pool;
export async function transaction(fn) {
  pool ??= new pg.Pool({connectionString:getConnectionString(),max:3,idleTimeoutMillis:10000,connectionTimeoutMillis:10000});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'");
    const result=await fn(client);
    await client.query('COMMIT');
    return result;
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export function environment(context) {
  const names=['STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','SPINFAMILY_PLUS_MONTHLY_PRICE_ID','SPINFAMILY_PLUS_ANNUAL_PRICE_ID','SPINFAMILY_CHECKOUT_ORIGIN','SPINFAMILY_ENABLE_PRODUCTION_BILLING'];
  const env=Object.fromEntries(names.map(name=>[name,globalThis.Netlify?.env.get(name)]));
  env.CONTEXT=context?.deploy?.context;
  return env;
}
