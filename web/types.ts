export type Collection = 'providers' | 'models' | 'routes' | 'limits';

export interface Entity {
  id: string;
  name?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface Provider extends Entity {
  name: string;
  kind?: string;
  baseUrl?: string;
  description?: string;
}

export interface Model extends Entity {
  name: string;
  providerId?: string;
  modelId?: string;
  contextWindow?: number;
  inputCost?: number;
  outputCost?: number;
}

export interface Route extends Entity {
  alias: string;
  providerId: string;
  modelId?: string;
  priority: number;
}

export interface Limit extends Entity {
  alias?: string;
  requestLimit?: number | null;
  requestsUsed?: number;
  usdLimit?: number | null;
  usdUsed?: number;
}

export interface GatewayKey extends Entity {
  name: string;
  createdAt: string;
  revoked: number;
  key?: string;
}

export interface RequestLog extends Entity {
  createdAt: string;
  status: number;
  model: string;
  stream: number;
  request: string;
  response: string;
}

export interface DashboardData {
  providers: Provider[];
  models: Model[];
  routes: Route[];
  limits: Limit[];
  keys: GatewayKey[];
  logs: RequestLog[];
}

export type Section = 'overview' | Collection | 'keys' | 'logs' | 'setup';
