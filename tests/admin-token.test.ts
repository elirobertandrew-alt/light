import { describe, expect, it } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { resolveAdminToken } from '../src/admin-token.js';

describe('resolveAdminToken', () => {
  it('uses LIGHT_ADMIN_TOKEN when set', () => {
    const token = resolveAdminToken({ env: 'from-env', tokenFile: '/tmp/light-admin-token-test-unused' });
    expect(token).toBe('from-env');
  });

  it('generates and persists a token to disk when none is configured, and reuses it on next boot', () => {
    const file = '/tmp/light-admin-token-test.txt';
    try { rmSync(file); } catch { /* ignore */ }
    const first = resolveAdminToken({ env: undefined, tokenFile: file });
    expect(first.length).toBeGreaterThan(20);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
    const second = resolveAdminToken({ env: undefined, tokenFile: file });
    expect(second).toBe(first);
  });
});
