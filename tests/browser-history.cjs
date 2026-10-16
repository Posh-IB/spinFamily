'use strict';
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:850},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:4317/',{waitUntil:'domcontentloaded'});
   await page.evaluate(()=>{
    window.__qa={accepted:0,completed:0,deleted:0,last:null};
    const state={timezone:'UTC',records:[],progress:{acceptedPlans:0,completedPlans:0,completedDays:0,currentDailyStreak:0,longestDailyStreakInSavedHistory:0}};
    const send=()=>window.dispatchEvent(new CustomEvent('spinfamily:history',{detail:structuredClone(state)}));
    window.spinFamilyHistory={
     eligible:()=>true,
     async accept(plan){
      window.__qa.accepted++;
      state.records.unshift({id:plan.id,status:'accepted',acceptedAt:new Date().toISOString(),completedAt:null,plan:{activities:plan.activities}});
      state.progress.acceptedPlans=state.records.length;
      window.__qa.last=plan;
      send();return structuredClone(state);
     },
     async complete(id){
      window.__qa.completed++;
      const record=state.records.find(x=>x.id===id);
      record.status='completed';record.completedAt=new Date().toISOString();
      state.progress.completedPlans=1;state.progress.completedDays=1;state.progress.currentDailyStreak=1;
      send();return structuredClone(state);
     },
     async remove(id){
      window.__qa.deleted++;
      state.records=state.records.filter(x=>x.id!==id);
      state.progress={acceptedPlans:0,completedPlans:0,completedDays:0,currentDailyStreak:0,longestDailyStreakInSavedHistory:0};
      send();return structuredClone(state);
     }
    };
   });
   await page.locator('#spinBtn').click();
   await page.locator('#results.open').waitFor({timeout:20000});
   await page.locator('#acceptBtn').click();
   await page.locator('.history-record').waitFor();
   assert.equal(await page.locator('#progressSummary').innerText().then(x=>x.includes('Completed plans: 0')),true);
   assert.equal(await page.locator('.history-record').count(),1);
   assert.equal(await page.locator('button[data-history-action="complete"]').count(),1);
   const accepted=await page.evaluate(()=>window.__qa);
   assert.equal(accepted.accepted,1);assert.equal(accepted.completed,0);
   assert.equal(accepted.last.activities.reduce((n,x)=>n+x.durationMinutes,0),120);
   await page.locator('button[data-history-action="complete"]').click();
   await page.waitForFunction(()=>document.querySelector('#progressSummary').textContent.includes('Completed plans: 1'));
   assert.equal(await page.locator('button[data-history-action="complete"]').count(),0);
   assert.equal(await page.evaluate(()=>window.__qa.completed),1);
   await page.screenshot({path:'qa-screenshots/history-'+width+'.png',fullPage:true});
   await page.evaluate(()=>{window.confirm=()=>true;});
   await page.locator('button[data-history-action="delete"]').click();
   await page.waitForFunction(()=>document.querySelector('#historyList').textContent.includes('No saved family plans yet.'));
   assert.equal(await page.evaluate(()=>window.__qa.deleted),1);
   assert.deepEqual(errors,[]);
   await page.close();
   console.log('HISTORY VISUAL FIXTURE PASS',width);
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
