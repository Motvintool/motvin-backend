import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * How Motvin MCP is used, counted per day, for the admin's MCP usage tab:
 * tool calls (and which tools), the AI tools people call from, how many people
 * were active, new connections, errors, calls refused by the rate limits, and
 * the searches people ran.
 *
 * Privacy: in the admin report people are counted, not recorded — each is a
 * one-way hash of their account id, used only to tell how many different
 * people were active. Search phrases are kept as typed (trimmed, lower-cased)
 * so the admin can see what people look for; only the most common per day.
 *
 * Each person can also see their own usage (Settings → AI tools): their calls
 * per day for the last week and their last few searches, filed under the same
 * one-way hash and only ever returned to that person.
 *
 * Kept for 90 days in a small JSON file, written at most every 30 seconds.
 */

export interface UsageDay {
  date: string;
  calls: number;
  errors: number;
  rateLimited: number;
  connections: number;
  tools: Record<string, number>;
  clients: Record<string, number>;
  /** One-way hashes of the people active that day. */
  people: string[];
  queries: Record<string, number>;
}

export interface UsageCall {
  uid: string;
  client: string | null;
  tool: string;
  query?: string | null;
  outcome: 'ok' | 'error' | 'rate_limited';
}

export interface UsageReport {
  days: { date: string; calls: number; people: number; errors: number; rateLimited: number; connections: number }[];
  totals: { calls: number; people: number; errors: number; rateLimited: number; connections: number };
  tools: { name: string; count: number }[];
  clients: { name: string; count: number }[];
  queries: { text: string; count: number }[];
}

/** One person's own usage, for their settings page. */
interface PersonUsage {
  days: Record<string, number>;
  searches: { query: string; tool: string; client: string | null; at: number }[];
}

export interface PersonalUsage {
  days: { date: string; calls: number }[];
  searches: { query: string; tool: string; client: string | null; at: string }[];
}

const KEEP_DAYS = 90;
const PERSON_DAYS = 7;
const PERSON_SEARCHES = 10;
const QUERIES_PER_DAY = 300;
const SAVE_EVERY_MS = 30_000;

@Injectable()
export class McpUsageService implements OnModuleDestroy {
  private readonly logger = new Logger(McpUsageService.name);
  private readonly file: string | null;
  private readonly daysByDate = new Map<string, UsageDay>();
  /** Per person (one-way hash of their id): calls per day and recent searches. */
  private readonly people = new Map<string, PersonUsage>();
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: ConfigService) {
    this.file = config.get<string>('mcp.usageFile') || join(config.get<string>('dataRoot') || './data', '.mcp-usage.json');
    this.load();
  }

  /** One tool call. */
  recordCall(call: UsageCall): void {
    const day = this.today();
    if (call.outcome === 'rate_limited') {
      day.rateLimited += 1;
    } else {
      day.calls += 1;
      if (call.outcome === 'error') day.errors += 1;
      day.tools[call.tool] = (day.tools[call.tool] ?? 0) + 1;
      const client = (call.client || 'Unknown tool').slice(0, 60);
      day.clients[client] = (day.clients[client] ?? 0) + 1;
      const query = call.query?.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
      if (query && (query in day.queries || Object.keys(day.queries).length < QUERIES_PER_DAY)) {
        day.queries[query] = (day.queries[query] ?? 0) + 1;
      }
    }
    const person = hashPerson(call.uid);
    if (!day.people.includes(person)) day.people.push(person);
    if (call.outcome !== 'rate_limited') this.recordForPerson(person, call);
    this.markDirty();
  }

  /** The person's own last 7 days and recent searches (newest first). */
  personal(uid: string): PersonalUsage {
    const mine = this.people.get(hashPerson(uid));
    const dates = Array.from({ length: PERSON_DAYS }, (_, i) => isoDate(Date.now() - (PERSON_DAYS - 1 - i) * 86_400_000));
    return {
      days: dates.map((date) => ({ date, calls: mine?.days[date] ?? 0 })),
      searches: (mine?.searches ?? []).map((search) => ({ ...search, at: new Date(search.at).toISOString() })),
    };
  }

  /**
   * Forgets a person, for when they delete their account: their own days and
   * searches, and their (hashed) place in each day's head count. The day
   * totals stay, since they no longer point at anyone.
   */
  forget(uid: string): void {
    const person = hashPerson(uid);
    this.people.delete(person);
    for (const day of this.daysByDate.values()) day.people = day.people.filter((entry) => entry !== person);
    this.markDirty();
  }

  private recordForPerson(key: string, call: UsageCall): void {
    let mine = this.people.get(key);
    if (!mine) {
      mine = { days: {}, searches: [] };
      this.people.set(key, mine);
    }
    const today = isoDate(Date.now());
    mine.days[today] = (mine.days[today] ?? 0) + 1;
    const oldest = isoDate(Date.now() - (PERSON_DAYS - 1) * 86_400_000);
    for (const date of Object.keys(mine.days)) if (date < oldest) delete mine.days[date];

    const query = call.query?.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (query) {
      // The same search again moves to the top instead of filling the list.
      mine.searches = [
        { query, tool: call.tool, client: call.client, at: Date.now() },
        ...mine.searches.filter((search) => search.query.toLowerCase() !== query.toLowerCase()),
      ].slice(0, PERSON_SEARCHES);
    }
  }

  /** A person connected a new AI tool. */
  recordConnection(): void {
    this.today().connections += 1;
    this.markDirty();
  }

  /** The last `days` days, newest last, with the range's top tools, AI tools and searches. */
  report(days = 30, liveConnections = 0): UsageReport {
    const span = Math.min(Math.max(Math.floor(days) || 30, 1), KEEP_DAYS);
    const dates = Array.from({ length: span }, (_, i) => isoDate(Date.now() - (span - 1 - i) * 86_400_000));
    const people = new Set<string>();
    const tools: Record<string, number> = {};
    const clients: Record<string, number> = {};
    const queries: Record<string, number> = {};
    const totals = { calls: 0, people: 0, errors: 0, rateLimited: 0, connections: liveConnections };

    const list = dates.map((date) => {
      const day = this.daysByDate.get(date);
      if (!day) return { date, calls: 0, people: 0, errors: 0, rateLimited: 0, connections: 0 };
      day.people.forEach((p) => people.add(p));
      add(tools, day.tools);
      add(clients, day.clients);
      add(queries, day.queries);
      totals.calls += day.calls;
      totals.errors += day.errors;
      totals.rateLimited += day.rateLimited;
      return { date, calls: day.calls, people: day.people.length, errors: day.errors, rateLimited: day.rateLimited, connections: day.connections };
    });
    totals.people = people.size;

    return {
      days: list,
      totals,
      tools: top(tools, 20).map(([name, count]) => ({ name, count })),
      clients: top(clients, 20).map(([name, count]) => ({ name, count })),
      queries: top(queries, 25).map(([text, count]) => ({ text, count })),
    };
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.dirty) this.save();
  }

  private today(): UsageDay {
    const date = isoDate(Date.now());
    let day = this.daysByDate.get(date);
    if (!day) {
      day = { date, calls: 0, errors: 0, rateLimited: 0, connections: 0, tools: {}, clients: {}, people: [], queries: {} };
      this.daysByDate.set(date, day);
      this.prune();
    }
    return day;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.save();
    }, SAVE_EVERY_MS);
    this.timer.unref?.();
  }

  private prune(): void {
    const oldest = isoDate(Date.now() - (KEEP_DAYS - 1) * 86_400_000);
    for (const date of this.daysByDate.keys()) if (date < oldest) this.daysByDate.delete(date);
    // A person's record goes once they have neither a call this week nor a search this month.
    const week = isoDate(Date.now() - (PERSON_DAYS - 1) * 86_400_000);
    const month = Date.now() - 30 * 86_400_000;
    for (const [key, mine] of this.people) {
      const recentDay = Object.keys(mine.days).some((date) => date >= week);
      const recentSearch = mine.searches.some((search) => search.at >= month);
      if (!recentDay && !recentSearch) this.people.delete(key);
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      // Older files are just the list of days; newer ones add each person's own usage.
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as UsageDay[] | { days?: UsageDay[]; people?: Record<string, PersonUsage> };
      const days = Array.isArray(data) ? data : data.days ?? [];
      for (const day of days) if (day && typeof day.date === 'string') this.daysByDate.set(day.date, day);
      if (!Array.isArray(data) && data.people) for (const [key, mine] of Object.entries(data.people)) this.people.set(key, mine);
      this.prune();
    } catch (error) {
      this.logger.error(`Could not read ${this.file}; usage counts start fresh: ${(error as Error).message}`);
    }
  }

  private save(): void {
    this.dirty = false;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ days: [...this.daysByDate.values()], people: Object.fromEntries(this.people) }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.logger.error(`Could not save ${this.file}: ${(error as Error).message}`);
    }
  }
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const hashPerson = (uid: string) => createHash('sha256').update(`motvin-mcp:${uid}`).digest('hex').slice(0, 16);

function add(into: Record<string, number>, from: Record<string, number>) {
  for (const [key, value] of Object.entries(from)) into[key] = (into[key] ?? 0) + value;
}

function top(counts: Record<string, number>, n: number): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}
