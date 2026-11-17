import { appCardScreens } from './app-cards';
import type { InspirationScreen } from './loader.service';

/** The grid card's pick must match the site's (cover.ts): the admin's order first, else one cover. */

const screen = (id: string, screenType: string, extra: Partial<InspirationScreen> = {}) =>
  ({ id, screenType, style: [], states: [], ...extra }) as unknown as InspirationScreen;

describe('appCardScreens', () => {
  const splash = screen('s', 'splash');
  const darkHome = screen('h', 'home', { style: ['dark'] });
  const lightFeed = screen('f', 'feed', { style: ['light'] });
  const loadingHome = screen('lh', 'home', { states: ['loading'] });

  it('keeps the admin pick in order, skips unknown and repeated ids, caps at four', () => {
    const all = [splash, darkHome, lightFeed, loadingHome, screen('d', 'detail')];
    const picked = appCardScreens({ cardScreens: ['f', 'missing', 'h', 'f', 's', 'lh', 'd'] }, all);
    expect(picked.map((s) => s.id)).toEqual(['f', 'h', 's', 'lh']);
  });

  it('without a pick, prefers a light main screen over an earlier dark home', () => {
    expect(appCardScreens({ cardScreens: [] }, [splash, darkHome, lightFeed]).map((s) => s.id)).toEqual(['f']);
  });

  it('skips unsettled screens, and falls back past the splash', () => {
    expect(appCardScreens({ cardScreens: [] }, [splash, loadingHome, darkHome]).map((s) => s.id)).toEqual(['h']);
    expect(appCardScreens({ cardScreens: [] }, [splash, screen('m', 'modal'), screen('x', 'checkout')]).map((s) => s.id)).toEqual(['x']);
    expect(appCardScreens({ cardScreens: [] }, [splash]).map((s) => s.id)).toEqual(['s']);
  });

  it('is empty for an app with no screens', () => {
    expect(appCardScreens({ cardScreens: ['h'] }, [])).toEqual([]);
  });
});
