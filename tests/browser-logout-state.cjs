'use strict';
const {chromium}=require('playwright'),{build}=require('esbuild'),assert=require('node:assert/strict'),fs=require('node:fs');
(async()=>{
 const bundle=await build({entryPoints:['src/plus-client.js'],bundle:true,format:'esm',write:false,plugins:[{name:'identity-fixture',setup(b){
  b.onResolve({filter:/^@netlify\/identity$/},()=>({path:'identity',namespace:'qa'}));
  b.onLoad({filter:/.*/,namespace:'qa'},()=>({loader:'js',contents:`
   export const getSettings=async()=>({disableSignup:false,providers:{}});
   export const handleAuthCallback=async()=>null;
   export const getUser=async()=>window.__qa.user;
   export const logout=()=>{window.__qa.calls++;return new Promise((resolve,reject)=>{window.__qa.settle=()=>{if(window.__qa.mode==='success'){window.__qa.user=null;resolve();}else if(window.__qa.mode==='ended'){window.__qa.user=null;reject(Error('provider rejected'));}else reject(Error('provider rejected'));};});};
   export const login=async()=>{};export const signup=async()=>{};export const oauthLogin=async()=>{};
  `}));
 }}]});
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 try{for(const width of [390,1440]){
  const page=await browser.newPage({viewport:{width,height:850},reducedMotion:'reduce'}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.__qa={user:{id:'qa_parent'},calls:0,mode:'rejected',serverUnavailable:false};});
  await page.route('https://logout-qa.example/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync('index.html','utf8')});
   if(url.pathname==='/assets/plus-client.js')return route.fulfill({contentType:'text/javascript',body:bundle.outputFiles[0].text});
   if(url.pathname==='/api/account/session'){
    const state=await page.evaluate(()=>({user:window.__qa.user,unavailable:window.__qa.serverUnavailable}));
    return route.fulfill({status:state.unavailable?503:200,json:state.unavailable?{error:'authentication_unavailable'}:{authenticated:Boolean(state.user),subject:state.user?.id??null}});
   }
   if(url.pathname==='/api/household/plans')return route.fulfill({json:{timezone:'UTC',records:[],progress:{completedPlans:0,completedDays:0,currentDailyStreak:0}}});
   if(url.pathname==='/api/household/activities')return route.fulfill({status:403,json:{error:'plus_required'}});
   if(url.pathname==='/api/billing/status')return route.fulfill({json:{checkoutReady:false,portalReady:false}});
   return route.fulfill({status:404,body:''});
  });
  await page.goto('https://logout-qa.example/');
  await page.waitForFunction(()=>document.querySelector('#accountMembershipText').textContent.includes('Free household'));
  await page.locator('#accountOpenSignIn').click();
  assert.equal(await page.locator('#plusSignOut').isVisible(),true,'Account always reopens signed-in controls');
  await page.locator('#plusSignOut').click();
  assert.equal(await page.locator('#plusSignOut').isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.spinFamilyHistory.eligible()),false,'writes unavailable during logout');
  assert.equal(await page.locator('#progressPanel').isVisible(),false,'household data clears immediately');
  await page.evaluate(()=>window.__qa.settle());
  await page.waitForFunction(()=>document.querySelector('#plusAccountStatus').textContent.includes('still signed in'));
  assert.equal(await page.locator('#plusSignOut').isVisible(),true);
  assert.equal(await page.locator('#plusSignOut').isEnabled(),true);
  assert.equal(await page.evaluate(()=>window.spinFamilyHistory.eligible()),true);
  await page.evaluate(()=>{window.__qa.serverUnavailable=true;});
  await page.locator('#plusSignOut').click();await page.evaluate(()=>window.__qa.settle());
  await page.waitForFunction(()=>document.querySelector('#accountMembershipText').textContent.includes('could not be verified'));
  assert.equal(await page.evaluate(()=>window.spinFamilyHistory.eligible()),false);
  assert.equal(await page.locator('#plusSignOut').isEnabled(),true,'unknown session retains retry');
  await page.evaluate(()=>{window.__qa.serverUnavailable=false;window.__qa.mode='success';});
  await page.locator('#plusSignOut').click();await page.evaluate(()=>window.__qa.settle());
  await page.waitForFunction(()=>document.querySelector('#accountMembershipText').textContent.startsWith('Guest'));
  assert.equal(await page.locator('#plusSignOut').isVisible(),false);
  assert.equal(await page.evaluate(()=>window.spinFamilyHistory.eligible()),false);
  await page.screenshot({path:'qa-screenshots/logout-'+width+'.png',fullPage:true});
  assert.deepEqual(errors,[]);await page.close();console.log('REJECTED / UNKNOWN / SUCCESSFUL LOGOUT PASS',width);
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});

