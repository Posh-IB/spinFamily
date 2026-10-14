'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {sameOriginMutation}=require('../lib/request-security.cjs');
const url='https://deploy-preview-7--spinfamily-app.netlify.app/api/billing/checkout';
function req(origin){return {url,headers:{get:(name)=>name==='origin'?origin:null}};}
test('accepts same-origin browser writes',()=>assert.equal(sameOriginMutation(req('https://deploy-preview-7--spinfamily-app.netlify.app')),true));
test('rejects remote, http and missing browser origins',()=>{
  for(const v of [undefined,'null','http://deploy-preview-7--spinfamily-app.netlify.app','https://spinfamily-app.netlify.app','https://evil.example','https://deploy-preview-7--spinfamily-app.netlify.app.evil.example']){
    assert.equal(sameOriginMutation(req(v)),false,String(v));
  }
});
