import type { InspirationApp, InspirationScreen } from './loader.service';

/**
 * The screens an app's card shows in a grid — the same pick as the site's
 * `appCardScreens` (motvin-web src/lib/inspirations/cover.ts), made here so a
 * grid asks for a few screens per app instead of every app's full screen list.
 * Keep the two in step.
 */

/** How many screens an app card cycles through. */
export const MAX_CARD_SCREENS = 4;

const COVER_ORDER = ['home', 'dashboard', 'feed', 'landing', 'search', 'detail', 'product', 'profile'];
const NOT_A_COVER = new Set(['splash', 'loading', 'modal', 'empty', 'error', 'permission', 'success']);

const isLight = (screen: InspirationScreen) => (screen.style ?? []).includes('light');
const isSettled = (screen: InspirationScreen) => !(screen.states ?? []).some((v) => v !== 'keyboard' && v !== 'scrolled');

function mainCover(screens: InspirationScreen[]): InspirationScreen | null {
  const settled = screens.filter(isSettled);
  for (const type of COVER_ORDER) {
    const match = settled.find((s) => s.screenType === type);
    if (match) return match;
  }
  return null;
}

export function coverScreen(screens: InspirationScreen[]): InspirationScreen | null {
  if (!screens.length) return null;
  // A light main screen first, when the app has one.
  const light = mainCover(screens.filter(isLight));
  if (light) return light;
  const main = mainCover(screens);
  if (main) return main;
  const settled = screens.filter(isSettled);
  return settled.find((s) => !NOT_A_COVER.has(s.screenType)) ?? screens.find((s) => s.screenType !== 'splash') ?? screens[0];
}

/**
 * The admin's pick when there is one (only ids among `screens`, in their
 * order), otherwise the single automatic cover; empty when there are no screens.
 */
export function appCardScreens(app: Pick<InspirationApp, 'cardScreens'>, screens: InspirationScreen[]): InspirationScreen[] {
  const byId = new Map(screens.map((s) => [s.id, s]));
  const picked = [...new Set(app.cardScreens ?? [])]
    .map((id) => byId.get(id))
    .filter((s): s is InspirationScreen => Boolean(s))
    .slice(0, MAX_CARD_SCREENS);
  if (picked.length) return picked;
  const cover = coverScreen(screens);
  return cover ? [cover] : [];
}
