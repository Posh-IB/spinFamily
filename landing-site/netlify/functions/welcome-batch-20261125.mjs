import {getStore} from '@netlify/blobs';
import nodemailer from 'nodemailer';
import {runBatch} from '../../lib/welcome-batch.mjs';
export default async function handler(){
 const result=await runBatch({env:k=>process.env[k],storeFactory:()=>getStore({name:'pilot-welcome-v1',consistency:'strong'}),send:async(s,m)=>{const t=nodemailer.createTransport(s);try{return await t.sendMail(m)}finally{t.close()}},log:r=>console.info(JSON.stringify({component:'welcome-batch-20261125',...r}))});
 return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
}
// November 25 at 14:00 UTC (9 AM EST); hard date/time guard prevents later recurrence.
export const config={schedule:'0 14 25 11 *'};
