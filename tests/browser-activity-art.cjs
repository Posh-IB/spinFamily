const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.SPIN_QA_URL||'http://127.0.0.1:4317/';
fs.mkdirSync('qa-screenshots',{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const report={browser:browser.version(),base,results:[]};
 try{
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:900}}),errors=[],atlas=[];
   page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('atlas'))atlas.push(r.url());});
   await page.goto(base,{waitUntil:'domcontentloaded'});await page.locator('[data-page="activitiesPage"]').click();
   const images=page.locator('#activityList .activity-photo img');assert.equal(await images.count(),20);
   await images.evaluateAll(nodes=>nodes.forEach(i=>i.loading='eager'));
   await page.waitForFunction(()=>[...document.querySelectorAll('#activityList img')].every(i=>i.complete&&i.naturalWidth===552&&i.naturalHeight===448));
   const geometry=await images.evaluateAll(nodes=>nodes.map(i=>{const r=i.getBoundingClientRect(),s=getComputedStyle(i);return {src:i.getAttribute('src'),alt:i.alt,ratio:r.width/r.height,fit:s.objectFit,position:s.objectPosition};}));
   assert.equal(new Set(geometry.map(x=>x.src)).size,19);for(const g of geometry){assert.ok(g.src.startsWith('assets/activities/'));assert.ok(g.alt.length>10);assert.ok(Math.abs(g.ratio-552/448)<.015,'Extra cropping: '+JSON.stringify(g));assert.equal(g.fit,'cover');assert.equal(g.position,'50% 50%');}
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
   await page.screenshot({path:'qa-screenshots/individual-activities-'+width+'.png',fullPage:true});
   // Exact custom Dance party uses the twentieth supplied asset, preserving the catalog.
   await page.locator('#activityName').fill('Dance party');await page.locator('#activityCategory').selectOption('family');await page.locator('#addActivityBtn').click();
   const dance=page.locator('#activityList .activity-tile').nth(20);await dance.scrollIntoViewIfNeeded();assert.equal(await dance.locator('img').getAttribute('src'),'assets/activities/dance-party.webp');await dance.locator('img').evaluate(i=>i.decode());
   const fallbacks={chore:'clean-the-kitchen',outdoor:'take-a-family-walk',family:'arts-and-crafts',selfcare:'quiet-reading'};
   for(const category of Object.keys(fallbacks)){
    await page.locator('#activityName').fill('Custom '+category+' activity');await page.locator('#activityCategory').selectOption(category);await page.locator('#addActivityBtn').click();
    const card=page.locator('#activityList .activity-tile').last();await card.scrollIntoViewIfNeeded();assert.equal(await card.locator('img').getAttribute('src'),'assets/activities/'+fallbacks[category]+'.webp');assert.ok((await card.locator('img').getAttribute('alt')).startsWith('Representative'));await card.locator('img').evaluate(i=>i.decode());
   }
   await page.screenshot({path:'qa-screenshots/custom-fallbacks-'+width+'.png',fullPage:true});
   // Deliberate asset failure, actual browser error events; no mocked app response.
   await page.route('**/assets/activities/dance-party.webp*',r=>r.abort());await dance.locator('img').evaluate(i=>{i.src='assets/activities/dance-party.webp?failure=1';});
   await page.waitForFunction(()=>document.querySelectorAll('#activityList .activity-tile')[20].querySelector('img').getAttribute('src')==='assets/activities/arts-and-crafts.webp');
   await page.route('**/assets/activities/arts-and-crafts.webp*',r=>r.abort());await dance.locator('img').evaluate(i=>{i.src='assets/activities/arts-and-crafts.webp?failure=1';});
   await page.waitForFunction(()=>document.querySelectorAll('#activityList .activity-tile')[20].classList.contains('image-unavailable')||document.querySelectorAll('#activityList .activity-tile')[20].querySelector('.image-unavailable'));
   assert.equal(await dance.locator('.art-fallback').isVisible(),true);await dance.screenshot({path:'qa-screenshots/unavailable-image-'+width+'.png'});
   assert.deepEqual(errors,[]);assert.deepEqual(atlas,[]);report.results.push({width,curated:20,exact:19,bedtimeFallback:'quiet-reading',suppliedImages:20,customCategories:4,failureRecovery:'pass',crop:'full 552:448 frame',pageErrors:0});
   await page.close();
  }
  console.log('INDIVIDUAL ART BROWSER PASS',JSON.stringify(report));
 }finally{fs.writeFileSync('qa-screenshots/activity-art-results.json',JSON.stringify(report,null,2));await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
