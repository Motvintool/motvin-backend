import { Logger } from '@nestjs/common';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * The AI tools each person has connected, so they can see them and disconnect
 * one from Motvin's settings.
 *
 * Tokens are stateless, so without this list the server would not know which
 * connections exist. One entry per connection (the `grant` every token of an
 * approval shares): who it belongs to, which tool, when it was connected and
 * last used, and when its last refresh token runs out — after that the entry
 * is dropped, because the connection is over anyway.
 *
 * Saved to a small JSON file (private to the server). "Last used" changes on
 * every tool call, so those updates are written at most once a minute; a
 * connect, refresh or disconnect is written straight away.
 */

export interface Connection {
  id: string;
  uid: string;
  email: string;
  clientName: string | null;
  /** ms since epoch */
  connectedAt: number;
  /** ms since epoch */
  lastUsedAt: number;
  /** unix seconds: when the connection's latest refresh token expires */
  expiresAt: number;
  /** Tool calls per day (YYYY-MM-DD), the last 7 days only. */
  recent?: Record<string, number>;
}

const RECENT_DAYS = 7;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

const LAST_USED_FLUSH_MS = 60_000;

export class ConnectionStore {
  private readonly entries = new Map<string, Connection>();
  private readonly logger = new Logger(ConnectionStore.name);
  private dirty = false;
  private lastSave = 0;

  constructor(private readonly file: string | null) {
    this.load();
  }

  /** A new connection, or a refresh that moves its expiry on. */
  upsert(entry: Omit<Connection, 'lastUsedAt' | 'connectedAt'> & { connectedAt?: number }): void {
    const now = Date.now();
    const current = this.entries.get(entry.id);
    this.entries.set(entry.id, {
      ...entry,
      connectedAt: current?.connectedAt ?? entry.connectedAt ?? now,
      lastUsedAt: now,
      recent: current?.recent ?? {},
    });
    this.save(true);
  }

  /** The connection was just used; saved within a minute. */
  touch(id: string): void {
    const current = this.entries.get(id);
    if (!current) return;
    current.lastUsedAt = Date.now();
    this.dirty = true;
    if (Date.now() - this.lastSave >= LAST_USED_FLUSH_MS) this.save(true);
  }

  /** One tool call on this connection, for its "used N times this week". Saved with the last-used time. */
  countCall(id: string): void {
    const current = this.entries.get(id);
    if (!current) return;
    const today = isoDate(Date.now());
    const recent = current.recent ?? {};
    recent[today] = (recent[today] ?? 0) + 1;
    const oldest = isoDate(Date.now() - (RECENT_DAYS - 1) * 86_400_000);
    for (const day of Object.keys(recent)) if (day < oldest) delete recent[day];
    current.recent = recent;
    this.dirty = true;
    if (Date.now() - this.lastSave >= LAST_USED_FLUSH_MS) this.save(true);
  }

  /** Tool calls on this connection in the last 7 days. */
  callsThisWeek(id: string): number {
    const recent = this.entries.get(id)?.recent ?? {};
    const oldest = isoDate(Date.now() - (RECENT_DAYS - 1) * 86_400_000);
    return Object.entries(recent).reduce((sum, [day, n]) => (day >= oldest ? sum + n : sum), 0);
  }

  get(id: string): Connection | undefined {
    const entry = this.entries.get(id);
    return entry && entry.expiresAt > nowSeconds() ? entry : undefined;
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.save(true);
  }

  /** One person's live connections, most recently used first. */
  listFor(uid: string): Connection[] {
    const t = nowSeconds();
    return [...this.entries.values()]
      .filter((entry) => entry.uid === uid && entry.expiresAt > t)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Every live connection (usage stats count them). */
  all(): Connection[] {
    const t = nowSeconds();
    return [...this.entries.values()].filter((entry) => entry.expiresAt > t);
  }

  /** Writes pending "last used" times; called on shutdown. */
  flush(): void {
    if (this.dirty) this.save(true);
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Connection[];
      if (Array.isArray(data)) for (const entry of data) if (entry && typeof entry.id === 'string') this.entries.set(entry.id, entry);
      this.prune();
    } catch (error) {
      this.logger.error(`Could not read ${this.file}; starting with no connections listed: ${(error as Error).message}`);
    }
  }

  private prune(): void {
    const t = nowSeconds();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= t) this.entries.delete(id);
  }

  private save(force: boolean): void {
    if (!force) return;
    this.prune();
    this.dirty = false;
    this.lastSave = Date.now();
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.entries.values()]), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.logger.error(`Could not save ${this.file}: ${(error as Error).message}`);
    }
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
