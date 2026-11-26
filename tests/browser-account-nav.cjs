'use strict';
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{
  for(const width of [390,1440]){
   const page=await browser.newPage({viewport:{width,height:850},reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto('http://127.0.0.1:4317/',{waitUntil:'domcontentloaded'});
   for(const target of ['spinPage','activitiesPage','familyPage','guidePage','aboutPage']){
    if(target!=='spinPage')await page.locator('[data-page="'+target+'"]').click();
    assert.equal(await page.locator('#accountOpenSignIn').isVisible(),true,'Sign-in entry from '+target);
    assert.equal(await page.locator('#accountOpenCreate').isVisible(),true,'Free account entry from '+target);
    await page.locator('#accountOpenCreate').click();
    assert.equal(await page.locator('#plusAccountPanel').isVisible(),true);
    await page.locator('#plusSignUp').click();
    assert.match(await page.locator('#plusAccountStatus').innerText(),/email address/i,'Empty registration gives useful feedback');
    assert.equal(await page.locator('#accountMembershipText').innerText(),'Guest · Progress is not saved');
    // Account toggles closed without logging the household out.
    await page.locator('#accountOpenSignIn').click();
    assert.equal(await page.locator('#plusAccountPanel').isVisible(),false,'Account toggles closed from '+target);
    assert.equal(await page.locator('#accountOpenSignIn').getAttribute('aria-expanded'),'false');
    await page.locator('#accountOpenSignIn').click();
    assert.equal(await page.locator('#plusAccountPanel').isVisible(),true,'Account opens again on '+target);
    assert.match(await page.locator('#plusAccountStatus').innerText(),/sign in to save/i);
    await page.locator('#accountClose').click();
    assert.equal(await page.locator('#plusAccountPanel').isVisible(),false,'Explicit Close works on '+target);
    await page.locator('#accountOpenSignIn').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#plusAccountPanel').isVisible(),false,'Escape closes on '+target);
    await page.locator('#accountOpenSignIn').click();
    if(target!=='aboutPage'){
      const next=['spinPage','activitiesPage','familyPage','guidePage','aboutPage'][['spinPage','activitiesPage','familyPage','guidePage','aboutPage'].indexOf(target)+1];
      await page.locator('[data-page="'+next+'"]').click();
      assert.equal(await page.locator('#plusAccountPanel').isVisible(),false,'Changing tab closes Account');
      await page.locator('[data-page="'+target+'"]').click();
    }else{
      await page.locator('#accountClose').click();
    }
   }
   await page.screenshot({path:'qa-screenshots/free-auth-'+width+'.png',fullPage:true});
   assert.deepEqual(errors,[],'Page script errors');
   console.log('FREE ACCOUNT ENTRY/VALIDATION BROWSER PASS',width);
   await page.close();
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
