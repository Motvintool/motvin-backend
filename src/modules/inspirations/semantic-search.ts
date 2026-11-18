import type { InspirationApp, InspirationScreen } from './loader.service';

/**
 * Meaning-based screen matching for the MCP server's search.
 *
 * AI tools phrase searches loosely — "screens that make cancelling hard",
 * "shopping basket", "create account" — while the library describes screens
 * in its own words ("cancellation", "cart", "sign up"). Plain substring
 * matching misses those. This index closes the gap without any outside model:
 *
 * - Words are reduced to a simple stem (cancelling → cancel, screens → screen).
 * - Words and phrases people use for the same thing share a concept
 *   (unsubscribe ≈ cancel, basket ≈ cart, sign up ≈ register ≈ create account),
 *   so a search matches a screen that says it differently.
 * - Every field of a screen is indexed with a weight (its name and type count
 *   more than its description), and rare, telling words count more than common
 *   ones (BM25), so "paywall" outweighs "screen".
 *
 * The result is a relevance score per screen; InspirationsService adds it to
 * its own taxonomy-based score, so explicit filters still apply.
 */

/** Groups of words and phrases that mean the same thing in UI design. */
const CONCEPTS: string[][] = [
  ['cancel', 'cancellation', 'unsubscribe', 'end subscription', 'churn', 'downgrade', 'stop subscription', 'cancel plan'],
  ['sign up', 'signup', 'register', 'registration', 'create account', 'join', 'new account', 'get started'],
  ['log in', 'login', 'sign in', 'signin', 'authenticate', 'authentication', 'welcome back'],
  ['paywall', 'subscription', 'subscribe', 'upgrade', 'premium', 'membership', 'pricing', 'plans', 'free trial', 'trial'],
  ['onboarding', 'welcome', 'intro', 'introduction', 'walkthrough', 'tutorial', 'first run', 'getting started', 'coach mark'],
  ['empty', 'empty state', 'no results', 'nothing here', 'zero state', 'blank', 'no data', 'no items'],
  ['checkout', 'payment', 'pay', 'purchase', 'buy', 'billing', 'place order'],
  ['cart', 'basket', 'shopping bag', 'shopping cart'],
  ['notification', 'push', 'alert', 'reminder'],
  ['permission', 'allow access', 'location access', 'camera access', 'consent', 'tracking permission'],
  ['settings', 'preferences', 'options', 'configuration'],
  ['profile', 'my account', 'account page'],
  ['search', 'lookup', 'search bar', 'search results'],
  ['filter', 'sort', 'refine'],
  ['error', 'failure', 'failed', 'something went wrong', 'oops', 'offline', 'retry'],
  ['loading', 'skeleton', 'spinner', 'placeholder'],
  ['dark mode', 'dark theme', 'night mode'],
  ['delete account', 'deactivate', 'close account', 'remove account'],
  ['share', 'invite', 'refer', 'referral', 'invite friends'],
  ['review', 'rating', 'rate', 'stars', 'feedback'],
  ['map', 'location', 'nearby', 'directions', 'address'],
  ['chat', 'message', 'messaging', 'inbox', 'conversation', 'direct message'],
  ['calendar', 'schedule', 'booking', 'reservation', 'appointment'],
  ['feed', 'timeline', 'stories', 'home feed'],
  ['discount', 'coupon', 'promo', 'promo code', 'offer', 'sale', 'deal', 'voucher'],
  ['verify', 'verification', 'otp', 'one time code', 'two factor', '2fa', 'confirm email', 'verification code'],
  ['password', 'forgot password', 'reset password', 'passcode'],
  ['dashboard', 'overview', 'summary', 'analytics', 'stats', 'insights'],
  ['receipt', 'order confirmed', 'confirmation', 'thank you'],
  ['order tracking', 'track order', 'delivery status', 'shipment', 'tracking'],
  ['wallet', 'balance', 'bank', 'transfer', 'send money'],
  ['favorite', 'favourite', 'wishlist', 'bookmark', 'saved'],
  ['player', 'video', 'music', 'playback', 'now playing', 'podcast'],
  ['camera', 'photo', 'scan', 'scanner'],
  ['help', 'support', 'faq', 'contact us', 'customer service'],
  ['terms', 'privacy', 'policy', 'legal'],
  ['rewards', 'points', 'loyalty', 'streak', 'achievement', 'badge'],
  ['goal', 'habit', 'progress tracker'],
  ['menu', 'restaurant', 'dish', 'meal', 'recipe'],
  ['flight', 'hotel', 'trip', 'travel', 'itinerary'],
  ['workout', 'exercise', 'fitness', 'training'],
  ['modal', 'popup', 'pop up', 'dialog', 'bottom sheet', 'overlay'],
  ['form', 'input', 'text field', 'fields'],
  ['tab bar', 'navigation', 'sidebar', 'nav bar', 'bottom navigation'],
  ['success', 'congratulations', 'completed', 'all set'],
  ['quiz', 'survey', 'questionnaire', 'poll'],
  ['upload', 'attach', 'import'],
  ['language', 'localization', 'translate'],
  ['edit profile', 'personal details', 'personal info'],
  ['comparison', 'compare', 'versus'],
];

/** Words that say nothing about which screen is wanted. */
const STOP = new Set([
  'a', 'an', 'the', 'of', 'for', 'with', 'and', 'or', 'to', 'in', 'on', 'at', 'by', 'from', 'as', 'is', 'are', 'be', 'that', 'which', 'what',
  'how', 'do', 'does', 'my', 'our', 'your', 'me', 'i', 'we', 'it', 'its', 'this', 'these', 'those', 'some', 'any', 'all',
  'show', 'find', 'give', 'get', 'see', 'look', 'looking', 'want', 'need', 'example', 'examples', 'like', 'similar',
  'screen', 'screens', 'page', 'pages', 'app', 'apps', 'ui', 'ux', 'design', 'designs', 'view', 'views', 'good', 'best', 'real',
]);

/** cancelling → cancel, screens → screen, stories → story, registered → register. Deliberately light. */
export function stem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  let verb = false;
  if (w.endsWith('ing') && w.length > 5) {
    w = w.slice(0, -3);
    verb = true;
  } else if (w.endsWith('ed') && w.length > 4) {
    w = w.slice(0, -2);
    verb = true;
  } else if (w.endsWith('es') && /(ss|sh|ch|x)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && w.length > 3) w = w.slice(0, -1);
  // cancell → cancel, stopp → stop: a doubled consonant left by -ing/-ed.
  if (verb && /([^aeious])\1$/.test(w)) w = w.slice(0, -1);
  return w;
}

const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[_/]/g, ' ')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);

/** Concept lookups: single stemmed words, and multi-word phrases as stemmed sequences. */
const SINGLE = new Map<string, number>();
const PHRASES: { stems: string[]; concept: number }[] = [];
CONCEPTS.forEach((group, concept) => {
  for (const term of group) {
    const stems = words(term).map(stem);
    if (stems.length === 1) {
      if (!SINGLE.has(stems[0])) SINGLE.set(stems[0], concept);
    } else {
      PHRASES.push({ stems, concept });
    }
  }
});

/** A text's search terms: its stems, plus the concepts its words and phrases express. */
export function terms(text: string, dropStop = false): string[] {
  const stems = words(text)
    .filter((w) => !(dropStop && STOP.has(w)))
    .map(stem);
  const out = [...stems];
  stems.forEach((s, i) => {
    const single = SINGLE.get(s);
    if (single !== undefined) out.push(`~${single}`);
    for (const phrase of PHRASES) {
      if (phrase.stems.every((p, k) => stems[i + k] === p)) out.push(`~${phrase.concept}`);
    }
  });
  return out;
}

/** How much each field of a screen counts. */
const FIELDS: { weight: number; text: (s: InspirationScreen, appName: string) => string }[] = [
  { weight: 3, text: (s) => s.name },
  { weight: 3, text: (s) => [s.screenType, ...(s.screenTypes ?? []), s.fineType || ''].join(' ') },
  { weight: 2, text: (s) => s.purpose || '' },
  { weight: 2, text: (s) => s.primaryAction || '' },
  { weight: 2, text: (s) => (s.states ?? []).join(' ') },
  { weight: 2, text: (_s, appName) => appName },
  { weight: 1.5, text: (s) => s.description || '' },
  { weight: 1.5, text: (s) => (s.tags ?? []).join(' ') },
  { weight: 1, text: (s) => [...(s.elements ?? []), s.industry].join(' ') },
];

const K1 = 1.2;
const B = 0.6;

export class SemanticIndex {
  private readonly docs: { id: string; tf: Map<string, number>; length: number }[] = [];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(screens: InspirationScreen[], apps: InspirationApp[]) {
    const appNames = new Map(apps.map((app) => [app.id, app.name]));
    let total = 0;
    for (const screen of screens) {
      const tf = new Map<string, number>();
      let length = 0;
      for (const field of FIELDS) {
        for (const term of terms(field.text(screen, appNames.get(screen.appId) || ''))) {
          tf.set(term, (tf.get(term) ?? 0) + field.weight);
          length += field.weight;
        }
      }
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      this.docs.push({ id: screen.id, tf, length });
      total += length;
    }
    this.avgLength = this.docs.length ? total / this.docs.length : 1;
  }

  /** Relevance of every screen that matches the query at all (BM25 over stems and concepts). */
  score(query: string): Map<string, number> {
    const asked = [...new Set(terms(query, true))];
    const scores = new Map<string, number>();
    if (!asked.length) return scores;
    const n = this.docs.length;
    const idf = new Map(asked.map((t) => [t, Math.log(1 + (n - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))]));
    for (const doc of this.docs) {
      let s = 0;
      for (const term of asked) {
        const f = doc.tf.get(term);
        if (!f) continue;
        // A concept match is worth a little less than the same word itself.
        const weight = term.startsWith('~') ? 0.8 : 1;
        s += weight * (idf.get(term) ?? 0) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.length) / this.avgLength)));
      }
      if (s > 0) scores.set(doc.id, s);
    }
    return scores;
  }
}
