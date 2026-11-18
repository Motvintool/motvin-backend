import type { InspirationApp, InspirationScreen } from './loader.service';
import { SemanticIndex, stem, terms } from './semantic-search';

const screen = (id: string, fields: Partial<InspirationScreen>): InspirationScreen =>
  ({
    id,
    appId: fields.appId ?? 'app',
    name: '',
    screenType: 'other',
    screenTypes: [],
    fineType: '',
    states: [],
    description: '',
    purpose: null,
    primaryAction: null,
    industry: 'other',
    tags: [],
    elements: [],
    style: [],
    ...fields,
  }) as InspirationScreen;

const apps = [{ id: 'app', name: 'Example' }, { id: 'shop', name: 'Shopco' }] as InspirationApp[];

const library = [
  screen('cancel', { name: 'Cancel membership', description: 'Unsubscribe flow with a retention offer', screenType: 'settings' }),
  screen('cart', { appId: 'shop', name: 'Cart', screenType: 'cart', description: 'Items ready to buy' }),
  screen('signup', { name: 'Create account', screenType: 'signup', primaryAction: 'Register with email' }),
  screen('home', { name: 'Home', screenType: 'home', description: 'Feed of stories from friends' }),
  screen('empty', { name: 'Inbox', states: ['empty'], description: 'No messages yet' }),
  screen('paywall-desc', { name: 'Feed', description: 'A soft paywall banner at the bottom' }),
  screen('paywall-name', { name: 'Paywall', screenType: 'paywall', description: 'Choose a plan' }),
];
const index = new SemanticIndex(library, apps);
const rank = (query: string) => [...index.score(query).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

describe('semantic search', () => {
  it('stems word forms to one root', () => {
    expect(stem('cancelling')).toBe('cancel');
    expect(stem('cancelled')).toBe('cancel');
    expect(stem('screens')).toBe('screen');
    expect(stem('stories')).toBe('story');
    expect(stem('scroll')).toBe('scroll');
    expect(stem('boxes')).toBe('box');
  });

  it('gives same-meaning words and phrases a shared concept', () => {
    const shared = (a: string, b: string) => terms(a).filter((t) => t.startsWith('~')).some((t) => terms(b).includes(t));
    expect(shared('unsubscribe', 'cancellation')).toBe(true);
    expect(shared('basket', 'cart')).toBe(true);
    expect(shared('create account', 'sign up')).toBe(true);
    expect(shared('basket', 'paywall')).toBe(false);
  });

  it('finds a screen that says the same thing in other words', () => {
    expect(rank('screens that make cancelling hard')[0]).toBe('cancel');
    expect(rank('shopping basket')[0]).toBe('cart');
    expect(rank('sign up with email')[0]).toBe('signup');
    expect(rank('no results state')).toContain('empty');
  });

  it('weighs a screen named for the query above one that only mentions it', () => {
    const order = rank('paywall');
    expect(order.indexOf('paywall-name')).toBeLessThan(order.indexOf('paywall-desc'));
  });

  it('matches nothing for a query about something else, or only filler words', () => {
    expect(index.score('quantum physics lecture').size).toBe(0);
    expect(index.score('show me some screens').size).toBe(0);
  });
});
