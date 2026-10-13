const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const results=[];
try{for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.SPIN_QA_URL||'http://127.0.0.1:4317/',{waitUntil:'networkidle'});
 await page.locator('#spinBtn').click();await page.locator('#results.open').waitFor();assert.ok(await page.locator('.plan-card').count());await page.locator('#closeBtn').click();
 await page.locator('[data-page="familyPage"]').click();await page.locator('#householdStatus').filter({hasText:'Guest planning remains available'}).waitFor();
 await page.locator('#checkout-monthly').click();assert.match(await page.locator('#householdStatus').innerText(),/Sign in/);assert.equal(await page.locator('#householdPlus').isVisible(),false);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'overflow');assert.deepEqual(errors,[]);
 fs.mkdirSync('qa-screenshots',{recursive:true});await page.screenshot({path:'qa-screenshots/household-guest-'+width+'.png',fullPage:true});results.push({width,guestWheel:'pass',unconfiguredAccount:'truthful',checkout:'requires_identity',pageErrors:errors.length});await page.close();
}fs.writeFileSync('qa-screenshots/plus-guest-results.json',JSON.stringify({browser:browser.version(),results,identityLifecycle:'NOT TESTED',stripeLifecycle:'LOCAL FIXTURES ONLY'},null,2));}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
