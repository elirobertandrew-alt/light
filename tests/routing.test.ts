import { describe, expect, it } from 'vitest';
import { resolveRoute, type RouteCandidate } from '../src/routing.js';
const candidates: RouteCandidate[] = [
 {id:'slow', alias:'writer', providerId:'p1', priority:20, enabled:true},
 {id:'fast', alias:'writer', providerId:'p2', priority:10, enabled:true},
];
describe('deterministic routing',()=>{
 it('resolves aliases in ascending priority order',()=>expect(resolveRoute('writer',candidates,{}).map(x=>x.id)).toEqual(['fast','slow']));
 it('skips disabled routes',()=>expect(resolveRoute('writer',[...candidates,{id:'off',alias:'writer',providerId:'p3',priority:1,enabled:false}],{}).map(x=>x.id)).toEqual(['fast','slow']));
 it('blocks routes when monthly requests are exhausted',()=>expect(resolveRoute('writer',candidates,{requestLimit:2,requestsUsed:2})).toEqual([]));
 it('blocks routes when monthly spend is exhausted',()=>expect(resolveRoute('writer',candidates,{usdLimit:10,usdUsed:10})).toEqual([]));
 it('returns ordered fallbacks and excludes other aliases',()=>expect(resolveRoute('writer',[...candidates,{id:'other',alias:'coder',providerId:'p1',priority:0,enabled:true}],{}).map(x=>x.id)).toEqual(['fast','slow']));
});
