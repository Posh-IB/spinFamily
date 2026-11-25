import {getStore} from '@netlify/blobs';
import nodemailer from 'nodemailer';
import {recoverWelcome,recoveryStatus} from '../../lib/welcome-recovery.mjs';
export default async function handler(req,context){
 const env=k=>globalThis.Netlify?.env?.get(k)??process.env[k];
 const result=await recoverWelcome({env,siteId:context?.site?.id??env('SITE_ID'),deployContext:context?.deploy?.context??env('CONTEXT'),storeFactory:()=>getStore({name:'pilot-welcome-v1',consistency:'strong'}),send:async(s,m)=>{const t=nodemailer.createTransport(s);try{return await t.sendMail(m)}finally{t.close()}},log:r=>console.info(JSON.stringify({component:'welcome-batch-20261125',...r}))});
 return new Response(JSON.stringify(result),{status:recoveryStatus(result),headers:{'content-type':'application/json','cache-control':'no-store','x-robots-tag':'noindex'}});
}
// 9:40–11:00 AM EST Nov 25 2026 ONLY, with 5-minute scheduler ticks. Hard date guard prevents next-year dispatch.
export const config={schedule:'*/5 14,15 25 11 *'};
