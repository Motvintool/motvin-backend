import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * What the OAuth server has switched off before it expired: whole connections
 * (a disconnect), single refresh tokens (used up by rotation) and single access
 * tokens (revoked directly). Each entry is kept only until the thing it blocks
 * would have expired anyway.
 *
 * Tokens are stateless, so this list is the only memory the server has of a
 * revocation. It is written to a small JSON file so a restart cannot bring a
 * disconnected tool back to life. Without a file (tests, or a read-only disk)
 * it still works for the life of the process.
 */
export class RevocationList {
  private readonly entries = new Map<string, number>();
  private readonly logger = new Logger(RevocationList.name);

  constructor(private readonly file: string | null) {
    this.load();
  }

  has(key: string): boolean {
    const exp = this.entries.get(key);
    return exp !== undefined && exp > now();
  }

  /** Blocks `key` until `exp` (unix seconds). Saved to disk straight away. */
  add(key: string, exp: number): void {
    if (exp <= now()) return;
    const current = this.entries.get(key);
    if (current !== undefined && current >= exp) return;
    this.entries.set(key, exp);
    this.prune();
    this.save();
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const t = now();
    for (const [key, exp] of this.entries) if (exp <= t) this.entries.delete(key);
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [key, exp] of Object.entries(data)) if (typeof exp === 'number') this.entries.set(key, exp);
      this.prune();
    } catch (error) {
      this.logger.error(`Could not read ${this.file}; starting with an empty revocation list: ${(error as Error).message}`);
    }
  }

  /** Write to a temp file, then rename, so a crash mid-write never leaves a half file. */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.logger.error(`Could not save ${this.file}; revocations hold until the next restart: ${(error as Error).message}`);
    }
  }
}

const now = () => Math.floor(Date.now() / 1000);
