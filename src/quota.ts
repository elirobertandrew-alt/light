/**
 * Quota ledger — the decision core of usage-aware routing.
 *
 * A provider plan is not one limit. The Alibaba Model Studio $50 Coding Plan
 * enforces 6,000 requests/5h AND 45,000/week AND 90,000/month *simultaneously*,
 * so a candidate is only usable when EVERY window admits it. This module models
 * that as a set of windows per scope and reports which one binds.
 *
 * Pure and deterministic: `now` is always injected, never read from the clock,
 * so every behaviour below is testable without fake timers.
 */

export type QuotaUnit = 'requests' | 'tokens' | 'usd';

/** Whether a provider's terms permit non-interactive (backend/automated) use. */
export type TermsOfUse = 'backend_allowed' | 'interactive_only';

/** What kind of caller is asking. Backend calls cannot use interactive_only routes. */
export type CallContext = 'interactive' | 'backend';

export type CalendarPeriod = 'hour' | 'day' | 'week' | 'month';

interface WindowBase {
  id: string;
  /** Fraction of the limit held back as safety margin, 0..1. 0.05 = stop at 95%. */
  headroom?: number;
}

/** Sliding window, e.g. "6,000 requests per rolling 5 hours". */
export interface RollingWindow extends WindowBase {
  kind: 'rolling';
  unit: QuotaUnit;
  limit: number;
  windowMs: number;
}

/** Boundary-aligned window that resets, e.g. "10,000 units/day, midnight Pacific". */
export interface CalendarWindow extends WindowBase {
  kind: 'calendar';
  unit: QuotaUnit;
  limit: number;
  period: CalendarPeriod;
  /** IANA zone for boundary alignment. Defaults to UTC. DST-correct. */
  timeZone?: string;
  /** 0 = Sunday, 1 = Monday. Defaults to Monday (ISO). */
  weekStartsOn?: 0 | 1;
}

/** Token bucket for rate limits: `limit` is burst capacity, refilled continuously. */
export interface BucketWindow extends WindowBase {
  kind: 'bucket';
  unit: QuotaUnit;
  limit: number;
  refillPerSec: number;
}

/** Cap on simultaneous in-flight requests. */
export interface ConcurrencyWindow extends WindowBase {
  kind: 'concurrency';
  limit: number;
}

export type QuotaWindow = RollingWindow | CalendarWindow | BucketWindow | ConcurrencyWindow;

export function windowUnit(window: QuotaWindow): QuotaUnit {
  return window.kind === 'concurrency' ? 'requests' : window.unit;
}

/** Usage already attributed to a window. `oldestAt` sharpens rolling retry hints. */
export interface UsageReading {
  windowId: string;
  used: number;
  oldestAt?: number;
}

export type DenyReason = 'quota_exhausted' | 'terms_of_use' | 'disabled';

export interface QuotaDecision {
  allowed: boolean;
  reason?: DenyReason;
  /** The window that actually blocked — the one worth showing a human. */
  bindingWindowId?: string;
  retryAfterMs?: number;
  /** Smallest remaining allowance across all windows, in that window's unit. */
  remaining?: number;
}

// ---------------------------------------------------------------------------
// Calendar boundaries (DST-correct via Intl, no dependencies)
// ---------------------------------------------------------------------------

/** Offset of `timeZone` from UTC at instant `at`, in ms. */
function zoneOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - at;
}

/** Wall-clock fields of `at` as seen in `timeZone`. */
function zonedFields(at: number, timeZone: string) {
  const shifted = new Date(at + zoneOffsetMs(at, timeZone));
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(), weekday: shifted.getUTCDay(),
  };
}

/** UTC instant of a local wall-clock time in `timeZone`, correcting across DST. */
function instantFromZoned(y: number, mo: number, d: number, h: number, timeZone: string): number {
  const naive = Date.UTC(y, mo, d, h, 0, 0);
  const approx = naive - zoneOffsetMs(naive, timeZone);
  return naive - zoneOffsetMs(approx, timeZone);
}

/** Start instant of the calendar window containing `now`. */
export function calendarWindowStart(window: CalendarWindow, now: number): number {
  const timeZone = window.timeZone ?? 'UTC';
  const { year, month, day, hour, weekday } = zonedFields(now, timeZone);
  switch (window.period) {
    case 'hour':
      return instantFromZoned(year, month, day, hour, timeZone);
    case 'day':
      return instantFromZoned(year, month, day, 0, timeZone);
    case 'week': {
      const startsOn = window.weekStartsOn ?? 1;
      const back = (weekday - startsOn + 7) % 7;
      return instantFromZoned(year, month, day - back, 0, timeZone);
    }
    case 'month':
      return instantFromZoned(year, month, 1, 0, timeZone);
  }
}

/** Start instant of the NEXT calendar window — i.e. when this one resets. */
export function calendarWindowEnd(window: CalendarWindow, now: number): number {
  const timeZone = window.timeZone ?? 'UTC';
  const { year, month, day, hour } = zonedFields(now, timeZone);
  switch (window.period) {
    case 'hour':
      return instantFromZoned(year, month, day, hour + 1, timeZone);
    case 'day':
      return instantFromZoned(year, month, day + 1, 0, timeZone);
    case 'week': {
      // Step from the window's own start, since `now` may sit days into it.
      const from = zonedFields(calendarWindowStart(window, now), timeZone);
      return instantFromZoned(from.year, from.month, from.day + 7, 0, timeZone);
    }
    case 'month':
      return instantFromZoned(year, month + 1, 1, 0, timeZone);
  }
}

// ---------------------------------------------------------------------------
// Per-window evaluation
// ---------------------------------------------------------------------------

/** Limit after holding back headroom. Always at least 0. */
export function effectiveLimit(window: QuotaWindow): number {
  const headroom = Math.min(Math.max(window.headroom ?? 0, 0), 1);
  return Math.max(window.limit * (1 - headroom), 0);
}

export interface WindowVerdict {
  windowId: string;
  admits: boolean;
  remaining: number;
  retryAfterMs?: number;
}

/**
 * Does one window admit `amount` more of its unit?
 *
 * A bucket refills over time, so its usable allowance is capacity minus the
 * un-refilled debt rather than a flat counter.
 */
export function evaluateWindow(
  window: QuotaWindow,
  reading: UsageReading | undefined,
  amount: number,
  now: number,
): WindowVerdict {
  const used = Math.max(reading?.used ?? 0, 0);
  const limit = effectiveLimit(window);

  if (window.kind === 'bucket') {
    // Debt drains at refillPerSec; `oldestAt` marks when the debt was incurred.
    const since = reading?.oldestAt != null ? Math.max(now - reading.oldestAt, 0) : 0;
    const drained = (since / 1000) * window.refillPerSec;
    const outstanding = Math.max(used - drained, 0);
    const remaining = limit - outstanding;
    const admits = remaining >= amount;
    const deficit = amount - remaining;
    return {
      windowId: window.id,
      admits,
      remaining,
      retryAfterMs: admits || window.refillPerSec <= 0
        ? undefined
        : Math.ceil((deficit / window.refillPerSec) * 1000),
    };
  }

  const remaining = limit - used;
  const admits = remaining >= amount;
  if (admits) return { windowId: window.id, admits, remaining };

  let retryAfterMs: number | undefined;
  if (window.kind === 'calendar') {
    retryAfterMs = Math.max(calendarWindowEnd(window, now) - now, 0);
  } else if (window.kind === 'rolling') {
    // Precise when we know the oldest event; otherwise assume a full window.
    retryAfterMs = reading?.oldestAt != null
      ? Math.max(reading.oldestAt + window.windowMs - now, 0)
      : window.windowMs;
  }
  return { windowId: window.id, admits, remaining, retryAfterMs };
}

// ---------------------------------------------------------------------------
// Candidate admission
// ---------------------------------------------------------------------------

/** Cost of one request, per unit. Tokens are an estimate until the response lands. */
export interface RequestCost {
  requests?: number;
  tokens?: number;
  usd?: number;
}

export interface QuotaScope {
  scopeId: string;
  enabled?: boolean;
  /** Defaults to backend_allowed. Set interactive_only for plans like Alibaba's. */
  termsOfUse?: TermsOfUse;
  windows: QuotaWindow[];
}

function costFor(unit: QuotaUnit, cost: RequestCost): number {
  const value = unit === 'requests' ? cost.requests ?? 1 : unit === 'tokens' ? cost.tokens ?? 0 : cost.usd ?? 0;
  return Math.max(value, 0);
}

/**
 * Can this scope take the request right now?
 *
 * Every window must admit it. The reported binding window is the one with the
 * longest retry hint, since that is the true unblock time and the number a
 * human should see.
 */
export function admits(
  scope: QuotaScope,
  readings: UsageReading[],
  cost: RequestCost,
  context: CallContext,
  now: number,
): QuotaDecision {
  if (scope.enabled === false) {
    return { allowed: false, reason: 'disabled' };
  }

  // The Alibaba clause, enforced structurally: a plan sold for interactive use
  // cannot serve an autonomous backend, however much quota is left.
  const terms = scope.termsOfUse ?? 'backend_allowed';
  if (context === 'backend' && terms === 'interactive_only') {
    return { allowed: false, reason: 'terms_of_use' };
  }

  const byId = new Map(readings.map((r) => [r.windowId, r]));
  const verdicts = scope.windows.map((window) =>
    evaluateWindow(window, byId.get(window.id), costFor(windowUnit(window), cost), now),
  );

  const blocking = verdicts.filter((v) => !v.admits);
  if (blocking.length > 0) {
    const binding = blocking.reduce((worst, v) =>
      (v.retryAfterMs ?? 0) > (worst.retryAfterMs ?? 0) ? v : worst,
    );
    return {
      allowed: false,
      reason: 'quota_exhausted',
      bindingWindowId: binding.windowId,
      retryAfterMs: binding.retryAfterMs,
      remaining: Math.max(binding.remaining, 0),
    };
  }

  const tightest = verdicts.reduce(
    (min, v) => (v.remaining < min ? v.remaining : min),
    Number.POSITIVE_INFINITY,
  );
  return {
    allowed: true,
    remaining: Number.isFinite(tightest) ? tightest : undefined,
  };
}

/** A scope paired with its readings, for ranking. */
export interface ScopeState {
  scope: QuotaScope;
  readings: UsageReading[];
  /** Tie-break among admitting scopes. Lower wins. */
  priority?: number;
}

export interface RankedScope {
  scopeId: string;
  decision: QuotaDecision;
  priority: number;
}

/**
 * Order scopes into a fallback chain: admitting scopes first by priority, then
 * by most headroom remaining. Denied scopes are kept, ordered by how soon they
 * recover, so a caller can report "blocked, try again in N" instead of a bare
 * failure.
 */
export function rankScopes(
  states: ScopeState[],
  cost: RequestCost,
  context: CallContext,
  now: number,
): RankedScope[] {
  const ranked = states.map((state) => ({
    scopeId: state.scope.scopeId,
    decision: admits(state.scope, state.readings, cost, context, now),
    priority: state.priority ?? 0,
  }));

  return ranked.sort((a, b) => {
    if (a.decision.allowed !== b.decision.allowed) return a.decision.allowed ? -1 : 1;
    if (a.decision.allowed) {
      return a.priority - b.priority
        || (b.decision.remaining ?? 0) - (a.decision.remaining ?? 0)
        || a.scopeId.localeCompare(b.scopeId);
    }
    // Both denied: soonest recovery first, unavailable-forever last.
    const aRetry = a.decision.retryAfterMs ?? Number.POSITIVE_INFINITY;
    const bRetry = b.decision.retryAfterMs ?? Number.POSITIVE_INFINITY;
    return aRetry - bRetry || a.scopeId.localeCompare(b.scopeId);
  });
}
