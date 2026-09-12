import Database from 'better-sqlite3';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type Collection='providers'|'models'|'routes'|'limits';
export type Row={id:string;[key:string]:unknown};
const sensitive=/authorization|api[-_]?key|token|secret|password|cookie/i;
export function redactSecrets(value:unknown):unknown{
 if(Array.isArray(value))return value.map(redactSecrets);
 if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sensitive.test(k)?'[REDACTED]':redactSecrets(v)]));
 if(typeof value==='string')return value.replace(/(Bearer\s+)[\w.-]+/gi,'$1[REDACTED]').replace(/\brf_[A-Za-z0-9_-]+/g,'[REDACTED]');
 return value;
}
export function hashKey(key:string){const salt=randomBytes(16);const digest=scryptSync(key,salt,32);return `${salt.toString('hex')}:${digest.toString('hex')}`}
function matchKey(key:string,stored:string){
 try{
  const [s,h]=stored.split(':');
  if(!s||!h)return false;
  const saltBuf=Buffer.from(s,'hex'),hashBuf=Buffer.from(h,'hex');
  if(saltBuf.length===0||hashBuf.length===0)return false;
  const actual=scryptSync(key,saltBuf,hashBuf.length);
  return actual.length===hashBuf.length && timingSafeEqual(actual,hashBuf);
 }catch{return false}
}
export class RelayStore{
 private db:Database.Database;
 constructor(path=process.env.LIGHT_DB??'data/light.db'){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});this.db=new Database(path);this.db.pragma('journal_mode = WAL');
  this.db.exec(`CREATE TABLE IF NOT EXISTS entities(collection TEXT,id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY,name TEXT,hash TEXT NOT NULL,createdAt TEXT NOT NULL,revoked INTEGER DEFAULT 0);CREATE TABLE IF NOT EXISTS logs(id TEXT PRIMARY KEY,createdAt TEXT NOT NULL,status INTEGER,model TEXT,stream INTEGER,request TEXT,response TEXT);`)
 }
 close(){this.db.close()}
 create(collection:Collection,input:Record<string,unknown>){const row={id:randomBytes(8).toString('hex'),...input};this.db.prepare('INSERT INTO entities VALUES(?,?,?)').run(collection,row.id,JSON.stringify(row));return row}
 list(collection:Collection):Row[]{return this.db.prepare('SELECT json FROM entities WHERE collection=? ORDER BY rowid DESC').all(collection).map((r:any)=>JSON.parse(r.json))}
 update(collection:Collection,id:string,input:Record<string,unknown>){const prev=this.list(collection).find(x=>x.id===id);if(!prev)return null;const row={...prev,...input,id};this.db.prepare('UPDATE entities SET json=? WHERE collection=? AND id=?').run(JSON.stringify(row),collection,id);return row}
 remove(collection:Collection,id:string){return this.db.prepare('DELETE FROM entities WHERE collection=? AND id=?').run(collection,id).changes>0}
 createKey(name:string){const key=`rf_${randomBytes(24).toString('base64url')}`;const row={id:randomBytes(8).toString('hex'),name,hash:hashKey(key),createdAt:new Date().toISOString(),revoked:0};this.db.prepare('INSERT INTO keys VALUES(@id,@name,@hash,@createdAt,@revoked)').run(row);return {...row,key}}
 listKeys(){return this.db.prepare('SELECT id,name,hash,createdAt,revoked FROM keys ORDER BY rowid DESC').all() as Row[]}
 verifyKey(key:string){return (this.db.prepare('SELECT hash FROM keys WHERE revoked=0').all() as {hash:string}[]).some(r=>matchKey(key,r.hash))}
 revokeKey(id:string){return this.db.prepare('UPDATE keys SET revoked=1 WHERE id=?').run(id).changes>0}
 recordLog(log:{status:number;model:string;stream:boolean;request:unknown;response:unknown}){const row={id:randomBytes(8).toString('hex'),createdAt:new Date().toISOString(),...log,request:JSON.stringify(redactSecrets(log.request)),response:JSON.stringify(redactSecrets(log.response))};this.db.prepare('INSERT INTO logs VALUES(@id,@createdAt,@status,@model,@stream,@request,@response)').run({...row,stream:row.stream?1:0});return row}
 listLogs(){return this.db.prepare('SELECT * FROM logs ORDER BY rowid DESC').all() as Row[]}
 getLog(id:string){return this.db.prepare('SELECT * FROM logs WHERE id=?').get(id) as Row|undefined}
}
