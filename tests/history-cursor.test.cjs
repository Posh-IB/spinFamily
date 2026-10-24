'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {encodeCursor,decodeCursor,HISTORY_PAGE_SIZE,HISTORY_HARD_CAP}=require('../lib/history-cursor.cjs');
const id='32c92000-080a-4a1d-8714-d194246bdde9';
test('bounded pagination and extended save cap are versioned constants',()=>{assert.equal(HISTORY_PAGE_SIZE,50);assert.equal(HISTORY_HARD_CAP,10000);});
test('opaque keyset cursor roundtrips timestamp and row id',()=>{
 const c=encodeCursor({created_at:'2026-10-23T18:30:00.123Z',id});
 assert.deepEqual(decodeCursor(c),{createdAt:'2026-10-23T18:30:00.123Z',id});
 assert.equal(decodeCursor(null),null);
});
test('malformed and injection cursors fail closed',()=>{
 for(const x of ['foo','../foo','',42,'e30','a'.repeat(170),Buffer.from(JSON.stringify(['2026-10-23T18:30:00.123Z','not-a-uuid'])).toString('base64url')]){
  if(x===''){assert.equal(decodeCursor(x),null);continue;}
  assert.throws(()=>decodeCursor(x),/invalid_history_cursor/);
 }
});
test('modified or noncanonical cursors are not accepted',()=>{
 const c=encodeCursor({created_at:'2026-10-23T18:30:00.123Z',id});
 assert.throws(()=>decodeCursor(c+'X'),/invalid_history_cursor/);
});
test('cursor refuses invalid dates and IDs on encoding',()=>{
 assert.throws(()=>encodeCursor({id:'missing',created_at:new Date()}),/invalid_history_cursor/);
 assert.throws(()=>encodeCursor({id,created_at:'not a date'}),/invalid_history_cursor/);
});

test('cursor preserves PostgreSQL microseconds without rounding',()=>{const c=encodeCursor({cursor_created_at:'2026-10-23T18:30:00.123456Z',id});assert.equal(decodeCursor(c).createdAt,'2026-10-23T18:30:00.123456Z');});
