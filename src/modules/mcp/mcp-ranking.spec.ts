import { arrange, queryHash, richness, type Rankable } from './mcp-ranking';

/**
 * The ordering an AI sees. The cases come from a real "paywall" search: one
 * app's intro frame (a video and a progress bar) beat its actual plan screen,
 * equal scores came out A–Z by app, and education apps — half the library —
 * filled the first page.
 */

const screen = (appId: string, name: string, extra: Partial<Rankable> = {}): Rankable => ({
  id: `${appId}-${name}`.toLowerCase().replace(/\s+/g, '-'),
  appId,
  name,
  industry: 'education',
  elements: [],
  states: [],
  ...extra,
});
const apps = (list: Rankable[]) => list.map((s) => s.appId);

describe('richness', () => {
  const none = new Set<string>();

  it('counts real UI and ignores motion and chrome', () => {
    const intro = screen('brilliant', 'Premium offer', { elements: ['media-player', 'progress'] });
    const plans = screen('brilliant', 'Premium benefits', { elements: ['table', 'button'] });
    expect(richness(intro, none)).toBe(0);
    expect(richness(plans, none)).toBe(2);
  });

  it('holds a loading state against a screen unless the query asks for it', () => {
    const loading = screen('brainly', 'Plans loading', { elements: ['price'], states: ['loading'] });
    expect(richness(loading, none)).toBeLessThan(0);
    expect(richness(loading, new Set(['loading']))).toBeGreaterThan(0);
  });

  it('weighs an element the query names', () => {
    const priced = screen('a', 'Plans', { elements: ['price'] });
    expect(richness(priced, new Set(['price']))).toBeGreaterThan(richness(priced, new Set()));
  });
});

describe('arrange', () => {
  it("shows each app's fullest screen among equal scores", () => {
    const scored = [
      { screen: screen('brilliant', 'Premium offer', { elements: ['media-player', 'progress'] }), score: 4 },
      { screen: screen('brilliant', 'Premium benefits', { elements: ['tab-bar', 'table', 'button', 'cta'] }), score: 4 },
    ];
    expect(arrange(scored, 'paywall')[0].name).toBe('Premium benefits');
  });

  it('never lets a fuller screen jump a higher score', () => {
    const scored = [
      { screen: screen('a', 'Exact match'), score: 6 },
      { screen: screen('b', 'Busy screen', { elements: ['table', 'button', 'cta', 'price', 'list'] }), score: 4 },
    ];
    expect(apps(arrange(scored, 'x'))).toEqual(['a', 'b']);
  });

  it('orders tied apps by the query, not the alphabet, and the same way every time', () => {
    const ids = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
    const scored = ids.map((id) => ({ screen: screen(id, 'Plans', { industry: 'saas' }), score: 4 }));
    const once = apps(arrange(scored, 'paywall'));
    expect(once).not.toEqual(ids);
    expect(apps(arrange(scored, 'paywall'))).toEqual(once);
    expect(once).toEqual([...ids].sort((a, b) => queryHash('paywall', a) - queryHash('paywall', b)));
    // Another question puts other apps first.
    expect(apps(arrange(scored, 'checkout'))).not.toEqual(once);
  });

  it('alternates kinds of app among equal scores', () => {
    const scored = [
      ...['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id) => ({ screen: screen(id, 'Plans', { industry: 'education' }), score: 4 })),
      ...['a1', 'a2'].map((id) => ({ screen: screen(id, 'Plans', { industry: 'ai' }), score: 4 })),
      { screen: screen('f1', 'Plans', { industry: 'food' }), score: 4 },
    ];
    const firstFour = arrange(scored, 'paywall').slice(0, 4);
    expect(new Set(firstFour.map((s) => s.industry))).toEqual(new Set(['education', 'ai', 'food']));
  });

  it('still gives five apps for five results, and drops nothing', () => {
    const scored = ['a', 'a', 'a', 'b', 'b', 'c', 'd', 'e'].map((appId, i) => ({ screen: screen(appId, `Screen ${i}`), score: 4 }));
    const out = arrange(scored, 'paywall');
    expect(new Set(apps(out.slice(0, 5))).size).toBe(5);
    expect(out).toHaveLength(scored.length);
  });
});
