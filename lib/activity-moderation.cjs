'use strict';
// Shared server-side moderation boundary. Policy v0.1, conservative and auditable.
// This module is NOT a substitute for household entitlement verification.
const POLICY_VERSION='spin-family-custom-v0.2';
const CATEGORIES=new Set(['chore','outdoor','family','selfcare']);
const RULES=[
  {id:'sexual-minors',pattern:/\b(?:child\s*(?:porn|sex)|minor\s*(?:porn|sex)|csam)\b/i},
  {id:'sexual-explicit',pattern:/\b(?:porn|pornography|masturbat(?:e|ion)|sexual\s+intercourse)\b/i},
  {id:'violence-abuse',pattern:/\b(?:kill|murder|torture|abuse|assault)\b/i},
  {id:'illegal-drugs',pattern:/\b(?:cocaine|heroin|methamphetamine|meth|fentanyl)\b/i},
  {id:'hate',pattern:/\b(?:racial\s+slur|hate\s+crime)\b/i},
  {id:'profanity',pattern:/\b(?:fuck|shit|bitch)\b/i}
];
function normalize(value){
 return String(value).normalize('NFKC').toLowerCase()
 .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,'')
 .replace(/[013457@$!|]/g,ch=>({'0':'o','1':'i','3':'e','4':'a','5':'s','7':'t','@':'a','$':'s','!':'i','|':'i'}[ch]||ch))
 .replace(/([a-z])\1{2,}/g,'$1$1')
 .replace(/[^a-z0-9]+/g,' ').trim();
}
function compact(value){return normalize(value).replace(/\s+/g,'');}
const OBSCURED=[
 {id:'profanity',words:['fuck','shit','bitch']},
 {id:'sexual-explicit',words:['porn','pornography']},
 {id:'illegal-drugs',words:['cocaine','heroin','meth','fentanyl']}
];
function moderateActivity(input){
 if(!input||typeof input!=='object'||Array.isArray(input))return {ok:false,reason:'invalid_payload',policyVersion:POLICY_VERSION};
 const {name,category}=input;
 if(typeof name!=='string'||!name.trim()||name.trim().length>80||/[\u0000-\u001f\u007f]/.test(name))
  return {ok:false,reason:'invalid_name',policyVersion:POLICY_VERSION};
 if(!CATEGORIES.has(category))return {ok:false,reason:'invalid_category',policyVersion:POLICY_VERSION};
 const normalized=normalize(name),squashed=compact(name);
 for(const rule of RULES)if(rule.pattern.test(normalized))return {ok:false,reason:'blocked_content',ruleId:rule.id,policyVersion:POLICY_VERSION};
 // Compact matching detects spaced-out profanity and leetspeak without blocking
 // arbitrary substrings in legitimate words (e.g. 'class' or 'assistant').
 const tokens=normalized.split(' ');
 // Join adjacent one-character tokens anywhere in the phrase, not the whole
 // phrase: contextual 'watch p o r n tonight' must not bypass screening.
 const runs=normalized.match(/(?:\b[a-z]\b(?:\s+|$)){2,}/g)||[];
 const obscuredWords=runs.map(run=>run.replace(/\s/g,''));
 for(const group of OBSCURED)for(const word of group.words){
   if(squashed===word||obscuredWords.includes(word)||tokens.some(t=>t.replace(/([a-z])\1+/g,'$1')===word)||tokens.some(t=>t===word)||new RegExp('(?:^|[^a-z])'+word+'(?:$|[^a-z])').test(normalized))
     return {ok:false,reason:'blocked_content',ruleId:group.id,policyVersion:POLICY_VERSION};
 }
 return {ok:true,value:{name:name.trim(),category},policyVersion:POLICY_VERSION};
}
module.exports={moderateActivity,normalize,POLICY_VERSION};
