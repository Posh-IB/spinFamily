'use strict';
// Opaque, bounded keyset cursor. Ownership always comes from server-verified household.
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_PAGE_SIZE=50;
const HISTORY_HARD_CAP=10000;
function encodeCursor(row){
  if(!row||!UUID.test(row.id))throw new TypeError('invalid_history_cursor');
  const date=new Date(row.created_at);
  if(!Number.isFinite(+date))throw new TypeError('invalid_history_cursor');
  return Buffer.from(JSON.stringify([date.toISOString(),row.id.toLowerCase()]),'utf8').toString('base64url');
}
function decodeCursor(value){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||value.length>160||!/^[A-Za-z0-9_-]+$/.test(value))throw new TypeError('invalid_history_cursor');
  let data;
  try {data=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));}catch{throw new TypeError('invalid_history_cursor');}
  if(!Array.isArray(data)||data.length!==2||!UUID.test(data[1])||typeof data[0]!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data[0])||!Number.isFinite(Date.parse(data[0])))throw new TypeError('invalid_history_cursor');
  if(new Date(data[0]).toISOString()!==data[0]||encodeCursor({created_at:data[0],id:data[1]})!==value)throw new TypeError('invalid_history_cursor');
  return {createdAt:data[0],id:data[1].toLowerCase()};
}
module.exports={HISTORY_PAGE_SIZE,HISTORY_HARD_CAP,encodeCursor,decodeCursor};
