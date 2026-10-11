const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
fs.mkdirSync('qa-screenshots', {recursive:true});
(async () => {
 const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
 try {
  for (const width of [390,768,1440]) {
   const page = await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
   const errors = [];
   page.on('pageerror',err => errors.push(err.message));
   await page.goto('http://127.0.0.1:4317/',{waitUntil:'domcontentloaded'});
   await page.locator('[data-member="Dad"]').click();
   await page.locator('[data-page="activitiesPage"]').click();
   assert.equal(await page.locator('#activityParticipantName').innerText(),'Choosing with Dad');
   assert.equal(await page.locator('#activityParticipantSelect').inputValue(),'Dad');
   await page.screenshot({path:'qa-screenshots/participant-activities-'+width+'.png',fullPage:true});
   await page.locator('#activityParticipantSelect').selectOption('Lucas');
   await page.locator('[data-page="familyPage"]').click();
   assert.equal(await page.locator('#familySelection').innerText(),'Currently choosing: Lucas');
   assert.equal(await page.locator('[data-family-member="Lucas"]').getAttribute('aria-pressed'),'true');
   await page.locator('[data-family-member="Emma"]').click();
   await page.locator('[data-page="spinPage"]').click();
   assert.equal(await page.locator('[data-member="Emma"]').getAttribute('aria-pressed'),'true');
   await page.screenshot({path:'qa-screenshots/participant-home-'+width+'.png',fullPage:true});
   const geometry = await page.evaluate(()=>{
    const wrap = document.querySelector('.wheel-wrap').getBoundingClientRect();
    const wheel = document.querySelector('#wheel').getBoundingClientRect();
    const horz = (wheel.left+wheel.right)/2-(wrap.left+wrap.right)/2;
    const vert = (wheel.top+wheel.bottom)/2-(wrap.top+wrap.bottom)/2;
    return {horz,vert,overflow:document.documentElement.scrollWidth-innerWidth};
   });
   assert.ok(Math.abs(geometry.horz)<1.5,'Wheel horizontal centering: '+JSON.stringify(geometry));
   assert.ok(Math.abs(geometry.vert)<1.5,'Wheel vertical centering: '+JSON.stringify(geometry));
   assert.ok(geometry.overflow<3,'Horizontal overflow: '+JSON.stringify(geometry));
   const localCount=await page.evaluate(()=>localStorage.length);
   assert.equal(localCount,0,'Free anonymous visit should not store household/participant history');
   await page.reload({waitUntil:'domcontentloaded'});
   assert.equal(await page.locator('[data-member="Mom"]').getAttribute('aria-pressed'),'true');
   await page.locator('[data-page="activitiesPage"]').click();
   assert.equal(await page.locator('#activityParticipantName').innerText(),'Choosing with Mom');
   assert.deepEqual(errors,[],'Page errors: '+errors.join('; '));
   console.log('PARTICIPANT / WHEEL / ANONYMOUS BROWSER PASS',width,geometry);
   await page.close();
  }
 } finally { await browser.close(); }
})().catch(err=>{console.error(err);process.exitCode=1;});
