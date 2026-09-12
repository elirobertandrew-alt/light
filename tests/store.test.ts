import { afterEach, describe, expect, it } from 'vitest';
import { RelayStore, hashKey, redactSecrets } from '../src/store.js';
const stores:RelayStore[]=[];
afterEach(()=>stores.splice(0).forEach(s=>s.close()));
const make=()=>{const s=new RelayStore(':memory:');stores.push(s);return s};
describe('durable store security',()=>{
 it('hashes gateway keys and reveals plaintext only at creation',()=>{const s=make();const made=s.createKey('CI');expect(made.key).toMatch(/^rf_/);expect(s.listKeys()[0]).not.toHaveProperty('key');expect(s.listKeys()[0].hash).not.toContain(made.key);expect(s.verifyKey(made.key)).toBe(true)});
 it('redacts nested authorization and key-shaped secrets',()=>expect(redactSecrets({authorization:'Bearer abc',nested:{apiKey:'secret',safe:'ok'}})).toEqual({authorization:'[REDACTED]',nested:{apiKey:'[REDACTED]',safe:'ok'}}));
 it('persists CRUD metadata and logs',()=>{const s=make();const p=s.create('providers',{name:'Local placeholder',kind:'custom',enabled:false});s.recordLog({status:503,model:'writer',stream:false,request:{api_key:'x'},response:{error:'none'}});expect(s.list('providers')).toHaveLength(1);s.update('providers',p.id,{name:'Edited'});expect(s.list('providers')[0].name).toBe('Edited');expect(s.listLogs()[0].request).toContain('[REDACTED]');s.remove('providers',p.id);expect(s.list('providers')).toHaveLength(0)});
 it('uses salted hashes',()=>expect(hashKey('same')).not.toBe(hashKey('same')));
});
