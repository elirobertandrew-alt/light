import { describe, expect, it } from 'vitest';
import {
  admits, calendarWindowEnd, calendarWindowStart, effectiveLimit, evaluateWindow, rankScopes,
  type BucketWindow, type CalendarWindow, type QuotaScope, type RollingWindow, type ScopeState,
} from '../src/quota.js';

const HOUR = 3_600_000;

/** The real Alibaba Model Studio $50 Coding Plan: three windows, all at once. */
function alibabaPlan(termsOfUse: QuotaScope['termsOfUse'] = 'interactive_only'): QuotaScope {
  return {
    scopeId: 'alibaba-coding-plan',
    termsOfUse,
    windows: [
      { kind: 'rolling', id: 'per5h', unit: 'requests', limit: 6_000, windowMs: 5 * HOUR },
      { kind: 'calendar', id: 'perWeek', unit: 'requests', limit: 45_000, period: 'week' },
      { kind: 'calendar', id: 'perMonth', unit: 'requests', limit: 90_000, period: 'month' },
    ],
  };
}

describe('calendar window boundaries', () => {
  it('aligns a UTC day to midnight', () => {
    const window: CalendarWindow = { kind: 'calendar', id: 'd', unit: 'requests', limit: 10, period: 'day' };
    const now = Date.parse('2026-03-11T13:45:00Z');
    expect(new Date(calendarWindowStart(window, now)).toISOString()).toBe('2026-03-11T00:00:00.000Z');
    expect(new Date(calendarWindowEnd(window, now)).toISOString()).toBe('2026-03-12T00:00:00.000Z');
  });

  it("resets a YouTube-style quota at midnight Pacific, not UTC", () => {
    const window: CalendarWindow = {
      kind: 'calendar', id: 'yt', unit: 'requests', limit: 10_000, period: 'day',
      timeZone: 'America/Los_Angeles',
    };
    // 07:00Z on 2026-07-02 is midnight PDT the same day.
    const now = Date.parse('2026-07-02T08:00:00Z');
    expect(new Date(calendarWindowStart(window, now)).toISOString()).toBe('2026-07-02T07:00:00.000Z');
  });

  it('stays correct across a DST spring-forward boundary', () => {
    const window: CalendarWindow = {
      kind: 'calendar', id: 'yt', unit: 'requests', limit: 10_000, period: 'day',
      timeZone: 'America/Los_Angeles',
    };
    // US DST began 2026-03-08. Before it, midnight PST = 08:00Z; after, 07:00Z.
    const before = Date.parse('2026-03-07T12:00:00Z');
    const after = Date.parse('2026-03-09T12:00:00Z');
    expect(new Date(calendarWindowStart(window, before)).toISOString()).toBe('2026-03-07T08:00:00.000Z');
    expect(new Date(calendarWindowStart(window, after)).toISOString()).toBe('2026-03-09T07:00:00.000Z');
  });

  it('starts an ISO week on Monday and ends it seven days later', () => {
    const window: CalendarWindow = { kind: 'calendar', id: 'w', unit: 'requests', limit: 10, period: 'week' };
    const thursday = Date.parse('2026-09-17T10:00:00Z');
    expect(new Date(calendarWindowStart(window, thursday)).toISOString()).toBe('2026-09-14T00:00:00.000Z');
    expect(new Date(calendarWindowEnd(window, thursday)).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });

  it('honours weekStartsOn=0 for Sunday-based weeks', () => {
    const window: CalendarWindow = {
      kind: 'calendar', id: 'w', unit: 'requests', limit: 10, period: 'week', weekStartsOn: 0,
    };
    const thursday = Date.parse('2026-09-17T10:00:00Z');
    expect(new Date(calendarWindowStart(window, thursday)).toISOString()).toBe('2026-09-13T00:00:00.000Z');
  });

  it('rolls a month over into the next year', () => {
    const window: CalendarWindow = { kind: 'calendar', id: 'm', unit: 'requests', limit: 10, period: 'month' };
    const now = Date.parse('2026-12-20T10:00:00Z');
    expect(new Date(calendarWindowEnd(window, now)).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('headroom', () => {
  it('holds back a fraction of the limit', () => {
    expect(effectiveLimit({ kind: 'rolling', id: 'r', unit: 'requests', limit: 1_000, windowMs: HOUR, headroom: 0.05 })).toBe(950);
  });

  it('never yields a negative limit', () => {
    expect(effectiveLimit({ kind: 'concurrency', id: 'c', limit: 4, headroom: 2 })).toBe(0);
  });

  it('stops before the provider hard limit', () => {
    const window: RollingWindow = { kind: 'rolling', id: 'r', unit: 'requests', limit: 100, windowMs: HOUR, headroom: 0.1 };
    // 90 used is under the real limit but exactly at the headroom-adjusted one.
    expect(evaluateWindow(window, { windowId: 'r', used: 90 }, 1, 0).admits).toBe(false);
    expect(evaluateWindow(window, { windowId: 'r', used: 89 }, 1, 0).admits).toBe(true);
  });
});

describe('rolling windows', () => {
  const window: RollingWindow = { kind: 'rolling', id: 'per5h', unit: 'requests', limit: 6_000, windowMs: 5 * HOUR };

  it('reports precise recovery time from the oldest event', () => {
    const now = Date.parse('2026-09-14T12:00:00Z');
    const oldestAt = now - 4 * HOUR; // frees one hour from now
    const verdict = evaluateWindow(window, { windowId: 'per5h', used: 6_000, oldestAt }, 1, now);
    expect(verdict.admits).toBe(false);
    expect(verdict.retryAfterMs).toBe(HOUR);
  });

  it('falls back to a full window when the oldest event is unknown', () => {
    const verdict = evaluateWindow(window, { windowId: 'per5h', used: 6_000 }, 1, 0);
    expect(verdict.retryAfterMs).toBe(5 * HOUR);
  });
});

describe('token buckets', () => {
  const window: BucketWindow = { kind: 'bucket', id: 'rpm', unit: 'requests', limit: 60, refillPerSec: 1 };

  it('refills over elapsed time', () => {
    const now = 100_000;
    // 60 spent 30s ago, refilling at 1/s → 30 back, so 30 available.
    const verdict = evaluateWindow(window, { windowId: 'rpm', used: 60, oldestAt: now - 30_000 }, 30, now);
    expect(verdict.admits).toBe(true);
    expect(verdict.remaining).toBeCloseTo(30, 5);
  });

  it('quotes the wait needed to refill the deficit', () => {
    const now = 100_000;
    const verdict = evaluateWindow(window, { windowId: 'rpm', used: 60, oldestAt: now }, 10, now);
    expect(verdict.admits).toBe(false);
    expect(verdict.retryAfterMs).toBe(10_000); // 10 tokens at 1/s
  });

  it('never promises recovery when refill is disabled', () => {
    const stalled: BucketWindow = { ...window, refillPerSec: 0 };
    expect(evaluateWindow(stalled, { windowId: 'rpm', used: 60 }, 1, 0).retryAfterMs).toBeUndefined();
  });
});

describe('the Alibaba three-window plan', () => {
  const now = Date.parse('2026-09-17T12:00:00Z'); // a Thursday

  it('admits an interactive call with room in every window', () => {
    const decision = admits(alibabaPlan(), [
      { windowId: 'per5h', used: 10 },
      { windowId: 'perWeek', used: 1_000 },
      { windowId: 'perMonth', used: 5_000 },
    ], { requests: 1 }, 'interactive', now);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(5_990); // per5h is tightest: 6000-10
  });

  it('blocks on the 5-hour window while week and month have room', () => {
    const decision = admits(alibabaPlan(), [
      { windowId: 'per5h', used: 6_000, oldestAt: now - 4 * HOUR },
      { windowId: 'perWeek', used: 1_000 },
      { windowId: 'perMonth', used: 5_000 },
    ], { requests: 1 }, 'interactive', now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('quota_exhausted');
    expect(decision.bindingWindowId).toBe('per5h');
    expect(decision.retryAfterMs).toBe(HOUR);
  });

  it('reports the month as binding when it recovers latest', () => {
    const decision = admits(alibabaPlan(), [
      { windowId: 'per5h', used: 6_000, oldestAt: now - 4 * HOUR },
      { windowId: 'perWeek', used: 45_000 },
      { windowId: 'perMonth', used: 90_000 },
    ], { requests: 1 }, 'interactive', now);
    // Month resets 2026-10-01, later than the week or the 5h window.
    expect(decision.bindingWindowId).toBe('perMonth');
    expect(decision.retryAfterMs).toBe(Date.parse('2026-10-01T00:00:00Z') - now);
  });

  it('refuses a backend call on an interactive_only plan even when quota is untouched', () => {
    const decision = admits(alibabaPlan('interactive_only'), [], { requests: 1 }, 'backend', now);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('terms_of_use');
  });

  it('allows the same backend call once terms permit it', () => {
    const decision = admits(alibabaPlan('backend_allowed'), [], { requests: 1 }, 'backend', now);
    expect(decision.allowed).toBe(true);
  });

  it('treats a disabled scope as unusable before any other check', () => {
    const decision = admits({ ...alibabaPlan('backend_allowed'), enabled: false }, [], { requests: 1 }, 'interactive', now);
    expect(decision.reason).toBe('disabled');
  });
});

describe('cost units', () => {
  const scope: QuotaScope = {
    scopeId: 'spend',
    windows: [
      { kind: 'calendar', id: 'usdMonth', unit: 'usd', limit: 50, period: 'month' },
      { kind: 'calendar', id: 'tokDay', unit: 'tokens', limit: 1_000_000, period: 'day' },
    ],
  };

  it('charges usd and token windows independently', () => {
    const decision = admits(scope, [
      { windowId: 'usdMonth', used: 49.9 },
      { windowId: 'tokDay', used: 10 },
    ], { usd: 0.2, tokens: 500 }, 'backend', 0);
    expect(decision.allowed).toBe(false);
    expect(decision.bindingWindowId).toBe('usdMonth');
  });

  it('ignores units the request does not consume', () => {
    const decision = admits(scope, [{ windowId: 'usdMonth', used: 50 }], { tokens: 10 }, 'backend', 0);
    // usd cost defaults to 0, so a full usd window still admits a token-only request.
    expect(decision.allowed).toBe(true);
  });

  it('counts one request by default', () => {
    const counter: QuotaScope = {
      scopeId: 'c', windows: [{ kind: 'rolling', id: 'r', unit: 'requests', limit: 1, windowMs: HOUR }],
    };
    expect(admits(counter, [{ windowId: 'r', used: 1 }], {}, 'backend', 0).allowed).toBe(false);
  });
});

describe('concurrency', () => {
  it('blocks when in-flight requests reach the cap', () => {
    const scope: QuotaScope = { scopeId: 'c', windows: [{ kind: 'concurrency', id: 'inflight', limit: 2 }] };
    expect(admits(scope, [{ windowId: 'inflight', used: 2 }], {}, 'backend', 0).allowed).toBe(false);
    expect(admits(scope, [{ windowId: 'inflight', used: 1 }], {}, 'backend', 0).allowed).toBe(true);
  });

  it('gives no retry hint, since recovery depends on other requests finishing', () => {
    const scope: QuotaScope = { scopeId: 'c', windows: [{ kind: 'concurrency', id: 'inflight', limit: 1 }] };
    expect(admits(scope, [{ windowId: 'inflight', used: 1 }], {}, 'backend', 0).retryAfterMs).toBeUndefined();
  });
});

describe('ranking a fallback chain', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  const plan = (id: string, limit: number, used: number, priority: number): ScopeState => ({
    scope: { scopeId: id, windows: [{ kind: 'rolling', id: `${id}-r`, unit: 'requests', limit, windowMs: HOUR }] },
    readings: [{ windowId: `${id}-r`, used }],
    priority,
  });

  it('puts admitting scopes ahead of blocked ones', () => {
    const ranked = rankScopes([plan('exhausted', 10, 10, 0), plan('open', 10, 0, 5)], { requests: 1 }, 'backend', now);
    expect(ranked.map((r) => r.scopeId)).toEqual(['open', 'exhausted']);
    expect(ranked[0].decision.allowed).toBe(true);
  });

  it('orders admitting scopes by priority, not by headroom', () => {
    const ranked = rankScopes([plan('roomy', 1_000, 0, 9), plan('preferred', 10, 0, 1)], { requests: 1 }, 'backend', now);
    expect(ranked.map((r) => r.scopeId)).toEqual(['preferred', 'roomy']);
  });

  it('breaks a priority tie by most headroom', () => {
    const ranked = rankScopes([plan('tight', 10, 9, 1), plan('loose', 100, 0, 1)], { requests: 1 }, 'backend', now);
    expect(ranked.map((r) => r.scopeId)).toEqual(['loose', 'tight']);
  });

  it('orders blocked scopes by soonest recovery', () => {
    const slow: ScopeState = {
      scope: { scopeId: 'slow', windows: [{ kind: 'calendar', id: 'm', unit: 'requests', limit: 1, period: 'month' }] },
      readings: [{ windowId: 'm', used: 1 }],
    };
    const quick: ScopeState = {
      scope: { scopeId: 'quick', windows: [{ kind: 'rolling', id: 'r', unit: 'requests', limit: 1, windowMs: 60_000 }] },
      readings: [{ windowId: 'r', used: 1, oldestAt: now - 30_000 }],
    };
    const ranked = rankScopes([slow, quick], { requests: 1 }, 'backend', now);
    expect(ranked.map((r) => r.scopeId)).toEqual(['quick', 'slow']);
  });

  it('demotes an interactive_only plan for backend traffic but keeps it for interactive', () => {
    const states: ScopeState[] = [
      { scope: alibabaPlan('interactive_only'), readings: [], priority: 0 },
      { scope: { scopeId: 'paid-api', windows: [{ kind: 'rolling', id: 'p', unit: 'requests', limit: 100, windowMs: HOUR }] }, readings: [], priority: 9 },
    ];
    expect(rankScopes(states, { requests: 1 }, 'backend', now).map((r) => r.scopeId))
      .toEqual(['paid-api', 'alibaba-coding-plan']);
    // Interactively, the cheap plan is preferred again.
    expect(rankScopes(states, { requests: 1 }, 'interactive', now)[0].scopeId)
      .toBe('alibaba-coding-plan');
  });

  it('is deterministic when everything ties', () => {
    const a = plan('bbb', 10, 0, 1);
    const b = plan('aaa', 10, 0, 1);
    expect(rankScopes([a, b], { requests: 1 }, 'backend', now).map((r) => r.scopeId)).toEqual(['aaa', 'bbb']);
  });
});
