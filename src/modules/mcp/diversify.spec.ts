import { diversify } from './mcp-ranking';

/**
 * The mixing step behind every MCP screen list. The case that prompted it:
 * a search for "paywall" where ties fell in app order, so one app's screens —
 * several of them the same screen in different flows — filled the page.
 */

const s = (appId: string, name: string, id = `${appId}-${name}`) => ({ id, appId, name });
const ids = (screens: { id: string }[]) => screens.map((screen) => screen.id);

describe('diversify', () => {
  it('gives each app its best match before any app gets a second, keeping ranked order', () => {
    const ranked = [
      s('blinkist', 'Discount plans'),
      s('blinkist', 'Highlights offer'),
      s('blinkist', 'Free trial offer'),
      s('brainly', 'Subscription plans'),
      s('brainly', 'Plans loading'),
      s('brilliant', 'Premium offer'),
    ];
    expect(ids(diversify(ranked))).toEqual([
      'blinkist-Discount plans',
      'brainly-Subscription plans',
      'brilliant-Premium offer',
      'blinkist-Highlights offer',
      'brainly-Plans loading',
      'blinkist-Free trial offer',
    ]);
  });

  it('can allow more than one per app per round', () => {
    const ranked = [s('a', '1'), s('a', '2'), s('a', '3'), s('b', '1')];
    expect(ids(diversify(ranked, 2))).toEqual(['a-1', 'a-2', 'b-1', 'a-3']);
  });

  it('shows a near-copy (same app, same name) only after every distinct screen', () => {
    const ranked = [
      s('blinkist', 'Subscription plans', 'b1'),
      s('blinkist', 'Subscription plans', 'b2'),
      s('blinkist', 'subscription plans ', 'b3'),
      s('brainly', 'Subscription plans', 'r1'),
    ];
    expect(ids(diversify(ranked))).toEqual(['b1', 'r1', 'b2', 'b3']);
  });

  it('drops nothing, so paging still reaches every match', () => {
    const ranked = Array.from({ length: 30 }, (_, i) => s(`app${i % 3}`, `screen ${i % 7}`, `id${i}`));
    const out = diversify(ranked);
    expect(out).toHaveLength(ranked.length);
    expect(new Set(ids(out))).toEqual(new Set(ids(ranked)));
  });

  it('inside one app (no cap) keeps ranked order, copies last', () => {
    const ranked = [s('mobi', 'Home', 'h1'), s('mobi', 'Home', 'h2'), s('mobi', 'Cart', 'c1'), s('mobi', 'Offer', 'o1')];
    expect(ids(diversify(ranked, Infinity))).toEqual(['h1', 'c1', 'o1', 'h2']);
  });

  it('leaves a list that is already mixed as it was', () => {
    const ranked = [s('a', 'x'), s('b', 'x'), s('c', 'x'), s('a', 'y'), s('b', 'y')];
    expect(ids(diversify(ranked))).toEqual(ids(ranked));
  });
});
