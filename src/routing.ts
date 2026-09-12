export interface RouteCandidate { id:string; alias:string; providerId:string; priority:number; enabled:boolean }
export interface Budget { requestLimit?:number|null; requestsUsed?:number; usdLimit?:number|null; usdUsed?:number }
export function resolveRoute(alias:string, routes:RouteCandidate[], budget:Budget):RouteCandidate[]{
 if (budget.requestLimit != null && (budget.requestsUsed??0) >= budget.requestLimit) return [];
 if (budget.usdLimit != null && (budget.usdUsed??0) >= budget.usdLimit) return [];
 return routes.filter(route=>route.alias===alias && route.enabled).sort((a,b)=>a.priority-b.priority || a.id.localeCompare(b.id));
}
