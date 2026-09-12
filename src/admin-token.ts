import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export function resolveAdminToken({ env, tokenFile }: { env: string | undefined; tokenFile: string }): string {
  if (env && env.trim().length > 0) return env.trim();
  if (existsSync(tokenFile)) {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  }
  const token = randomBytes(24).toString('base64url');
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}
