/**
 * How the MCP server orders screens before an AI sees them.
 *
 * The library search scores coarsely — whole points for a matching screen
 * type, industry or word — so a broad query like "paywall" gives a hundred
 * screens the same score, and the search then orders them by id, which starts
 * with the app's name. Left alone, every broad search opened on the same few
 * A–C apps, often on their weakest frame. For inspiration that is the worst
 * order: what an AI should see first is many apps, many kinds of app, and the
 * screen of each that actually shows the pattern.
 *
 * So, keeping the search's score as the first key:
 *
 * 1. Among equal scores, a screen showing more real UI comes first
 *    (`richness`): Brilliant's "Premium benefits" (a table and buttons) beats
 *    its "Premium offer" intro (a video and a progress bar).
 * 2. Still tied, apps are taken in an order that depends on the query
 *    (`queryHash`), not the alphabet — fair across apps, but stable, so the
 *    same question gives the same page.
 * 3. Then `diversify` deals one screen per app per round, near-copies last,
 *    and within each round alternates kinds of app (`industry`) among equal
 *    scores, so a page of five is five apps and not five education apps.
 *
 * Nothing is dropped: paging still reaches every match.
 */

/** The fields the ordering reads. InspirationScreen has them all. */
export interface Rankable {
  id: string;
  appId: string;
  name: string;
  industry?: string;
  elements?: string[];
  states?: string[];
  purpose?: string | null;
  capture?: { brief?: boolean } | null;
}

/**
 * Elements that say nothing about what a screen offers: motion, loading and
 * chrome. A screen that is only these is a transition, not an example.
 */
const DECORATIVE = new Set(['media-player', 'progress', 'page-indicator', 'skeleton', 'keyboard', 'legal-text']);

/** States that mean the screen is on its way somewhere else. */
const TRANSITIONAL = new Set(['loading']);

/**
 * How much real UI a screen shows, as a tie-breaker among equal scores.
 * `asked` is the query's words: a state or element the query names is never
 * held against a screen ("loading screens" wants loading screens).
 */
export function richness(screen: Rankable, asked: Set<string>): number {
  let value = 0;
  for (const element of screen.elements ?? []) {
    if (asked.has(element)) value += 2;
    else if (!DECORATIVE.has(element)) value += 1;
  }
  value = Math.min(value, 8);
  for (const state of screen.states ?? []) if (TRANSITIONAL.has(state) && !asked.has(state)) value -= 3;
  if (screen.capture?.brief) value -= 2;
  if (screen.purpose) value += 1;
  return value;
}

/** FNV-1a: a fixed, query-dependent order of apps that is not the alphabet. */
export function queryHash(query: string, appId: string): number {
  let hash = 0x811c9dc5;
  const input = `${query.trim().toLowerCase()}\u0000${appId}`;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function queryWords(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .filter(Boolean),
  );
}

/**
 * Full ordering for a scored list from the search. `perApp` is how many of
 * one app a round may hold; searching inside one app passes Infinity.
 */
export function arrange<T extends Rankable>(scored: { screen: T; score: number }[], query: string, perApp = 1): T[] {
  const asked = queryWords(query);
  const keyed = scored.map(({ screen, score }) => ({
    screen,
    score,
    rich: richness(screen, asked),
    hash: queryHash(query, screen.appId),
  }));
  keyed.sort((a, b) => b.score - a.score || b.rich - a.rich || a.hash - b.hash || a.screen.id.localeCompare(b.screen.id));
  const scoreOf = new Map(keyed.map((k) => [k.screen.id, k.score]));
  return diversify(
    keyed.map((k) => k.screen),
    perApp,
    (screen) => scoreOf.get(screen.id) ?? 0,
  );
}

/**
 * Reorders an already ranked list so a page shows many apps, not one.
 *
 * - Near-copies (same app, same screen name) wait until every distinct screen
 *   has been shown.
 * - The distinct screens are dealt in rounds, at most `perApp` per app per
 *   round, each round keeping ranked order.
 * - When `scoreOf` is given, each run of equal scores inside a round
 *   alternates industries, so the kinds of app mix too.
 */
export function diversify<T extends Rankable>(screens: T[], perApp = 1, scoreOf?: (screen: T) => number): T[] {
  const seen = new Set<string>();
  const distinct: T[] = [];
  const copies: T[] = [];
  for (const screen of screens) {
    const key = `${screen.appId}\u0000${screen.name.trim().toLowerCase()}`;
    (seen.has(key) ? copies : distinct).push(screen);
    seen.add(key);
  }

  const order: T[] = [];
  let pool = distinct;
  while (pool.length) {
    const taken = new Map<string, number>();
    const round: T[] = [];
    const rest: T[] = [];
    for (const screen of pool) {
      const count = taken.get(screen.appId) ?? 0;
      if (count < perApp) {
        round.push(screen);
        taken.set(screen.appId, count + 1);
      } else {
        rest.push(screen);
      }
    }
    order.push(...(scoreOf ? mixIndustries(round, scoreOf) : round));
    pool = rest;
  }
  return [...order, ...copies];
}

/**
 * Within each run of equal scores, deals industries in turn — each industry
 * keeps its own order — so a tie among thirty education apps and three AI
 * apps does not open with ten education apps in a row.
 */
function mixIndustries<T extends Rankable>(round: T[], scoreOf: (screen: T) => number): T[] {
  const out: T[] = [];
  let start = 0;
  while (start < round.length) {
    const score = scoreOf(round[start]);
    let end = start;
    while (end < round.length && scoreOf(round[end]) === score) end++;

    const byIndustry = new Map<string, T[]>();
    for (const screen of round.slice(start, end)) {
      const industry = screen.industry ?? '';
      if (!byIndustry.has(industry)) byIndustry.set(industry, []);
      byIndustry.get(industry).push(screen);
    }
    const queues = [...byIndustry.values()];
    for (let i = 0; out.length < end; i++) {
      const queue = queues[i % queues.length];
      if (queue.length) out.push(queue.shift());
    }
    start = end;
  }
  return out;
}

/** How many different apps a list of screens comes from, as words: "1 app", "5 apps". */
export function appCount(screens: { appId: string }[]): string {
  const count = new Set(screens.map((screen) => screen.appId)).size;
  return `${count} ${count === 1 ? 'app' : 'apps'}`;
}
