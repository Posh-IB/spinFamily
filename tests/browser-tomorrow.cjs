'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(process.env.QA_BASE_URL||'http://127.0.0.1:4317/',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#plusAccountStatus').textContent.includes('unavailable'));
  assert.equal(await page.locator('#tomorrowPanel').isVisible(),false,'guest panel hidden');
  await page.evaluate(()=>{
   window.__suggestOptions=null;
   window.spinFamilyHistory={...window.spinFamilyHistory,
    planningChoices:async()=>({activities:[{id:'story',name:'Read a story together'}]}),
    suggest:async options=>{window.__suggestOptions=options;return {date:'2026-10-17',timezone:'America/New_York',message:'Based on caregiver-confirmed completed plans.',plans:[{activities:[{name:'Read a story together',start:1080,end:1105}]}]};}
   };
   window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:{records:[],progress:{}}}));
  });
  await page.locator('#tomorrowGenerate').click();
  await page.locator('#tomorrowChoices input[data-choice="routines"]').waitFor({state:'attached'});
  await page.locator('#tomorrowPanel summary').click();
  await page.locator('#tomorrowChoices input[data-choice="routines"]').check();
  await page.locator('#tomorrowGenerate').click();
  await page.locator('#tomorrowResults article').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.__suggestOptions.routines),['story']);
  assert.equal(await page.locator('#tomorrowResults').innerText().then(t=>t.includes('Read a story together')),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  const panels=await page.evaluate(()=>{const a=document.querySelector('#tomorrowPanel').getBoundingClientRect(),b=document.querySelector('#progressPanel').getBoundingClientRect();return {bottom:a.bottom,nextTop:b.top};});
  assert.ok(panels.nextTop>=panels.bottom,'new panels must never overlap');
  await page.screenshot({path:'qa-screenshots/tomorrow-'+width+'.png',fullPage:true});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:null})));
  assert.equal(await page.locator('#tomorrowPanel').isVisible(),false);
  assert.equal(await page.locator('#tomorrowResults article').count(),0);
  assert.deepEqual(errors,[]);await page.close();console.log('TOMORROW VISUAL FIXTURE PASS',width);
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

