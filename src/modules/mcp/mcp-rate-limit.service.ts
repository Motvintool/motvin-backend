import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Rate limits for Motvin MCP, so one person, script or runaway AI loop cannot
 * flood the server or copy the library wholesale.
 *
 * - Tool calls, per signed-in person: a per-minute and a per-day budget. Over
 *   either, the call comes back as a tool error the AI can read and relay.
 * - Screen previews, per person: their own per-minute budget, because resizing
 *   images is the most expensive thing a tool does. Over it, results simply
 *   come back without images.
 * - OAuth endpoints, per client address: registration, sign-in and token
 *   exchange need no account, so they are limited by address (429).
 *
 * Counters live in memory, which is right for a single API instance. With
 * several instances each counts on its own; a shared store (Redis) would be
 * needed for one budget across all of them. A limit of 0 turns that limit off.
 *
 * The per-day counters are also saved to a small file (at most every 30
 * seconds, and on shutdown), so a restart neither hands everyone a fresh day
 * nor makes "Today" on the settings page drop back to 0 while the week's
 * usage still shows the calls. Minute counters aren't worth saving.
 */

export interface McpRateLimits {
  callsPerMinute: number;
  callsPerDay: number;
  previewsPerMinute: number;
  oauthPerMinute: number;
}

export interface LimitResult {
  ok: boolean;
  /** Seconds until the budget that ran out starts again (0 when ok). */
  retryAfter: number;
  /** Which budget ran out, for the message. */
  window?: 'minute' | 'day';
}

export const DEFAULT_RATE_LIMITS: McpRateLimits = {
  callsPerMinute: 60,
  callsPerDay: 2000,
  previewsPerMinute: 60,
  oauthPerMinute: 30,
};

const MINUTE = 60;
const DAY = 24 * 3600;
/** Above this many tracked windows, expired ones are swept out. */
const SWEEP_AT = 5000;
/** Only these windows are saved across restarts: each person's day. */
const SAVED_PREFIX = 'call:d:';
const SAVE_EVERY_MS = 30_000;

type Window = { count: number; resetAt: number };

@Injectable()
export class McpRateLimitService implements OnModuleDestroy {
  /** Read once at boot; tests may replace it. */
  limits: McpRateLimits;
  private readonly windows = new Map<string, Window>();
  private readonly logger = new Logger(McpRateLimitService.name);
  /** Where the per-day counters are saved; null when there is no data folder (unit tests). */
  private readonly file: string | null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: ConfigService) {
    const configured = config.get<Partial<McpRateLimits>>('mcp.rateLimits') ?? {};
    this.limits = { ...DEFAULT_RATE_LIMITS, ...pickNumbers(configured) };
    const dataRoot = config.get<string>('dataRoot');
    this.file = config.get<string>('mcp.rateLimitFile') || (dataRoot ? join(dataRoot, '.mcp-rate-limits.json') : null);
    this.load();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.dirty) this.save();
  }

  /** One tool call by this person; counts against both the minute and the day. */
  takeCall(uid: string): LimitResult {
    const minute = this.peek(`call:m:${uid}`, this.limits.callsPerMinute);
    if (!minute.ok) return { ...minute, window: 'minute' };
    const day = this.peek(`call:d:${uid}`, this.limits.callsPerDay);
    if (!day.ok) return { ...day, window: 'day' };
    this.count(`call:m:${uid}`, this.limits.callsPerMinute, MINUTE);
    this.count(`call:d:${uid}`, this.limits.callsPerDay, DAY);
    return { ok: true, retryAfter: 0 };
  }

  /** Where the person stands against the daily budget, without counting anything. */
  dailyStatus(uid: string): { used: number; limit: number; resetsAt: number | null } {
    const limit = this.limits.callsPerDay;
    const current = this.windows.get(`call:d:${uid}`);
    if (!current || current.resetAt <= Date.now()) return { used: 0, limit, resetsAt: null };
    return { used: current.count, limit, resetsAt: current.resetAt };
  }

  /** One screen preview for this person. */
  takePreview(uid: string): LimitResult {
    return this.take(`preview:${uid}`, this.limits.previewsPerMinute, MINUTE, 'minute');
  }

  /** One request to an OAuth endpoint from this address. */
  takeOAuth(address: string): LimitResult {
    return this.take(`oauth:${address}`, this.limits.oauthPerMinute, MINUTE, 'minute');
  }

  private take(key: string, limit: number, seconds: number, window: 'minute' | 'day'): LimitResult {
    const state = this.peek(key, limit);
    if (!state.ok) return { ...state, window };
    this.count(key, limit, seconds);
    return state;
  }

  /** Whether one more is allowed, without counting it. */
  private peek(key: string, limit: number): LimitResult {
    if (limit <= 0) return { ok: true, retryAfter: 0 };
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) return { ok: true, retryAfter: 0 };
    if (current.count < limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  }

  private count(key: string, limit: number, seconds: number): void {
    if (limit <= 0) return;
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      if (this.windows.size >= SWEEP_AT) this.sweep(now);
      this.windows.set(key, { count: 1, resetAt: now + seconds * 1000 });
    } else {
      current.count += 1;
    }
    if (key.startsWith(SAVED_PREFIX)) this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_EVERY_MS);
    this.timer.unref?.();
  }

  /** Brings back the per-day counters that haven't run out yet. */
  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Window>;
      const now = Date.now();
      for (const [key, window] of Object.entries(data ?? {})) {
        if (!key.startsWith(SAVED_PREFIX) || !window || typeof window.count !== 'number' || typeof window.resetAt !== 'number') continue;
        if (window.resetAt > now) this.windows.set(key, { count: window.count, resetAt: window.resetAt });
      }
    } catch (error) {
      this.logger.error(`Could not read ${this.file}; daily counts start fresh: ${(error as Error).message}`);
    }
  }

  private save(): void {
    this.dirty = false;
    if (!this.file) return;
    const now = Date.now();
    const days: Record<string, Window> = {};
    for (const [key, window] of this.windows) if (key.startsWith(SAVED_PREFIX) && window.resetAt > now) days[key] = window;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(days), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.logger.error(`Could not save ${this.file}: ${(error as Error).message}`);
    }
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

/** Keeps only real, non-negative numbers, so a bad setting falls back to the default. */
function pickNumbers(input: Partial<McpRateLimits>): Partial<McpRateLimits> {
  const out: Partial<McpRateLimits> = {};
  for (const key of Object.keys(DEFAULT_RATE_LIMITS) as (keyof McpRateLimits)[]) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = Math.floor(value);
  }
  return out;
}

/** "in 42 seconds", "in 3 minutes", "in 5 hours" — for messages a person may read. */
export function waitText(seconds: number): string {
  if (seconds < 90) return `in ${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `in ${minutes} minutes`;
  return `in ${Math.ceil(minutes / 60)} hours`;
}
