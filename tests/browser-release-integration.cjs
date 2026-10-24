'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const out={local:[],hosted:[],errors:[]};fs.mkdirSync('qa-screenshots',{recursive:true});
 const root=path.resolve('dist');
 const server=http.createServer((req,res)=>{const file=path.resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!file.startsWith(root+path.sep)&&file!==root){res.writeHead(403);return res.end();}const target=file===root||req.url==='/'?path.join(root,'index.html'):file;if(!fs.existsSync(target)||fs.statSync(target).isDirectory()){res.writeHead(503);return res.end('{}');}res.setHeader('content-type',target.endsWith('.js')?'text/javascript':target.endsWith('.html')?'text/html':target.endsWith('.webp')?'image/webp':'application/octet-stream');fs.createReadStream(target).pipe(res);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await chromium.launch({headless:true,timeout:20000});
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded',timeout:20000});
   await page.waitForFunction(()=>document.querySelector('#plusAccountStatus').textContent.includes('unavailable'));
   assert.equal(await page.locator('#tomorrowPanel').isVisible(),false);
   await page.evaluate(()=>{window.__options=[];window.spinFamilyHistory={...window.spinFamilyHistory,planningChoices:async()=>({activities:[{id:'custom',name:'Indoor treasure hunt'}]}),suggest:async options=>{window.__options.push(options);return {date:'2026-10-28',timezone:'America/New_York',message:'Review your plan.',plans:[{activities:[{name:'Indoor treasure hunt',start:1080,end:1110}]}]};}};window.dispatchEvent(new CustomEvent('spinfamily:entitlement',{detail:{plus:true}}));window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:{records:[],progress:{}}}));});
   await page.locator('#tomorrowGenerate').click();await page.locator('#scheduleSelection').selectOption('today');await page.locator('#scheduleDaypart').selectOption('evening');await page.locator('#tomorrowGenerate').click();await page.locator('#tomorrowResults article').waitFor();
   assert.deepEqual(await page.evaluate(()=>window.__options[0].schedule),{selection:'today',daypart:'evening'});
   await page.locator('#scheduleSelection').selectOption('future');await page.locator('#scheduleDate').fill('2026-10-28');await page.locator('#tomorrowGenerate').click();await page.waitForFunction(()=>window.__options.length===2);assert.equal(await page.evaluate(()=>window.__options[1].schedule.date),'2026-10-28');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
   await page.screenshot({path:'qa-screenshots/scheduling-'+width+'.png',fullPage:true});await page.evaluate(()=>window.dispatchEvent(new CustomEvent('spinfamily:entitlement',{detail:{plus:false}})));assert.equal(await page.locator('#tomorrowPanel').isVisible(),false);assert.equal(await page.locator('#tomorrowResults article').count(),0);out.local.push({width,status:'passed',scope:'UI fixture; actual Identity and PostgreSQL not exercised'});await page.close();
  }
  const page=await browser.newPage({viewport:{width:390,height:900}});await page.goto('https://deploy-preview-14--spinfamily-app.netlify.app/',{waitUntil:'domcontentloaded',timeout:20000});assert.equal(await page.locator('#spinBtn').count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'qa-screenshots/hosted-guest-390.png',fullPage:true});out.hosted.push({status:'passed',scope:'Older deployed commit; anonymous page only; no account or household writes'});await page.close();
 }catch(e){out.errors.push(String(e.stack||e));process.exitCode=1;}
 finally{if(browser)await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync('qa-screenshots/release-browser.json',JSON.stringify(out,null,2));console.log(JSON.stringify(out));}
})().catch(e=>{console.error(e);process.exitCode=1;});
