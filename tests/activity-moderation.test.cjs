'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {moderateActivity}=require('../lib/activity-moderation.cjs');
const check=(name,category='family')=>moderateActivity({name,category});
test('accepts ordinary family activities',()=>{
 for(const name of ['Read a story','Cook together','Play basketball','Science experiments','Take a class','Draw a picture']){
  assert.equal(check(name).ok,true,name);
 }
});
test('rejects existing prohibited examples and normalized evasions',()=>{
 for(const name of ['fuck','shit','bitch','cocaine','heroin','meth','porn','f u c k','f.u.c.k','p0rn','sh1t']){
  assert.equal(check(name).ok,false,name);
 }
});
test('rejects invalid names, categories and malformed payloads',()=>{
 for(const value of [null,[],{}, {name:'',category:'family'},{name:'Good',category:'admin'},{name:'x'.repeat(81),category:'family'},{name:'a\nb',category:'family'}]){
  assert.equal(moderateActivity(value).ok,false,JSON.stringify(value));
 }
});
test('does not treat valid names as curated or entitled',()=>{
 const result=check('Family movie night');
 assert.deepEqual(result.value,{name:'Family movie night',category:'family'});
 assert.equal(Object.hasOwn(result,'entitled'),false);
});
