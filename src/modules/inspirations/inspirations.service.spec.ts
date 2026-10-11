import { ConfigService } from '@nestjs/config';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InspirationsAdminService } from './inspirations-admin.service';
import { InspirationsService } from './inspirations.service';
import { LoaderService } from './loader.service';

/**
 * The query layer's platform scoping: what /meta offers a visitor browsing
 * one platform must be what exists on that platform, not the library's union.
 * Runs against a throwaway data root built through the admin service.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('InspirationsService.getCounts', () => {
  let tmp: string;
  let admin: InspirationsAdminService;
  let service: InspirationsService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-meta-'));
    const dataRoot = join(tmp, 'data');
    mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });
    const config = { get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined) } as unknown as ConfigService;
    const loader = new LoaderService(config);
    admin = new InspirationsAdminService(config, loader);
    service = new InspirationsService(loader);

    // Two apps in different industries: a phone app and a web app, each with
    // a screen type, a UI element and a flow of its own.
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.saveApp({ id: 'webby', name: 'Webby', industry: 'productivity' });
    admin.uploadScreen('ios', 'mobi', 'home.png', PNG_1X1, false, '');
    admin.uploadScreen('ios', 'mobi', 'cart.png', PNG_1X1, false, '');
    admin.uploadScreen('web', 'webby', 'feed.png', PNG_1X1, false, '');
    admin.uploadScreen('web', 'webby', 'compose.png', PNG_1X1, false, '');
    admin.saveScreenMeta('ios', 'mobi', 'home.png', { screenType: 'home', elements: ['tab-bar'] });
    admin.saveScreenMeta('ios', 'mobi', 'cart.png', { screenType: 'cart', elements: ['tab-bar', 'button'] });
    admin.saveScreenMeta('web', 'webby', 'feed.png', { screenType: 'feed', elements: ['navbar'] });
    admin.saveScreenMeta('web', 'webby', 'compose.png', { screenType: 'modal', elements: ['navbar'] });
    admin.saveFlow({ id: 'mobi-checkout', appId: 'mobi', name: 'Checkout', category: 'checkout', platform: 'ios', screenIds: ['mobi-ios-home', 'mobi-ios-cart'] });
    admin.saveFlow({ id: 'webby-posting', appId: 'webby', name: 'Posting', category: 'creation', platform: 'web', screenIds: ['webby-web-feed', 'webby-web-compose'] });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('without a platform is the whole library', async () => {
    const meta = await service.getCounts();
    expect(meta.counts.screens).toBe(4);
    expect(meta.taxonomy.screenTypes).toEqual(expect.arrayContaining(['home', 'cart', 'feed', 'modal']));
    expect(meta.taxonomy.industries).toEqual(expect.arrayContaining(['food', 'productivity']));
  });

  it('for web offers only what web has', async () => {
    const meta = await service.getCounts(['web']);
    expect(meta.counts.apps).toBe(1);
    expect(meta.counts.screens).toBe(2);
    expect(meta.counts.flows).toBe(1);
    expect(meta.counts['ui-elements']).toBe(2);
    expect(meta.taxonomy.screenTypes.sort()).toEqual(['feed', 'modal']);
    expect(meta.taxonomy.industries).toEqual(['productivity']);
    expect(meta.taxonomy.elements).toEqual(['navbar']);
    expect(meta.taxonomy.flowCategories).toEqual(['creation']);
  });

  it('for ios offers only what ios has', async () => {
    const meta = await service.getCounts(['ios']);
    expect(meta.counts.screens).toBe(2);
    expect(meta.taxonomy.screenTypes.sort()).toEqual(['cart', 'home']);
    expect(meta.taxonomy.industries).toEqual(['food']);
    expect(meta.taxonomy.elements).toEqual(['button', 'tab-bar']);
    expect(meta.taxonomy.flowCategories).toEqual(['checkout']);
  });

  it('for a platform with nothing stored is empty, and still lists the platforms that exist', async () => {
    const meta = await service.getCounts(['webapp']);
    expect(meta.counts.screens).toBe(0);
    expect(meta.counts.apps).toBe(0);
    expect(meta.taxonomy.screenTypes).toEqual([]);
    expect(meta.taxonomy.elements).toEqual([]);
    expect(meta.taxonomy.platforms.sort()).toEqual(['ios', 'web']);
  });

  it('for several platforms is their union', async () => {
    const meta = await service.getCounts(['ios', 'web']);
    expect(meta.counts.screens).toBe(4);
    expect(meta.taxonomy.industries.sort()).toEqual(['food', 'productivity']);
  });
});

describe('new taxonomy values, end to end', () => {
  let tmp: string;
  let admin: InspirationsAdminService;
  let service: InspirationsService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-new-type-'));
    const dataRoot = join(tmp, 'data');
    mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });
    const config = { get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined) } as unknown as ConfigService;
    const loader = new LoaderService(config);
    admin = new InspirationsAdminService(config, loader);
    service = new InspirationsService(loader);

    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.uploadScreen('ios', 'mobi', 'home.png', PNG_1X1, false, '');
    admin.uploadScreen('ios', 'mobi', 'offer.png', PNG_1X1, false, '');
    admin.saveScreenMeta('ios', 'mobi', 'home.png', { screenType: 'home', name: 'Mobi home' });
    // "paywall", "neon" and "offline" are not in the built-in lists.
    admin.saveScreenMeta('ios', 'mobi', 'offer.png', { screenType: 'paywall' as never, style: ['neon'] as never, states: ['offline'] as never, name: 'Mobi offer' });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('keeps the screen and offers the new values in the filters', async () => {
    const meta = await service.getCounts();
    expect(meta.counts.screens).toBe(2);
    expect(meta.taxonomy.screenTypes).toEqual(['home', 'paywall']);
    expect(meta.taxonomy.styles).toContain('neon');
    expect(meta.taxonomy.states).toContain('offline');
  });

  it('search counts and filters by a new value like any other', async () => {
    const all = await service.search('mobi');
    expect(all.facets?.screenTypes).toEqual({ home: 1, paywall: 1 });
    const narrowed = await service.search('mobi', 50, 0, { screenType: ['paywall'] });
    expect(narrowed.screens.map((s) => s.screenType)).toEqual(['paywall']);
    // A dimension's own counts ignore its own filter, so the other values stay pickable.
    expect(narrowed.facets?.screenTypes).toEqual({ home: 1, paywall: 1 });
    expect(narrowed.facets?.styles).toEqual({ neon: 1 });
  });
});

describe('search: what a query names becomes a visible filter', () => {
  let tmp: string;
  let service: InspirationsService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-literal-'));
    const dataRoot = join(tmp, 'data');
    mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });
    const config = { get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined) } as unknown as ConfigService;
    const loader = new LoaderService(config);
    const admin = new InspirationsAdminService(config, loader);
    service = new InspirationsService(loader);
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    for (const f of ['signin.png', 'otp.png', 'settings.png']) admin.uploadScreen('ios', 'mobi', f, PNG_1X1, false, '');
    admin.saveScreenMeta('ios', 'mobi', 'signin.png', { screenType: 'login', name: 'Sign in' });
    admin.saveScreenMeta('ios', 'mobi', 'otp.png', { screenType: 'login', name: 'Enter code' });
    // Mentions logging in, but is a settings screen.
    admin.saveScreenMeta('ios', 'mobi', 'settings.png', { screenType: 'settings', name: 'Login and security' });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('reads "login" as the Login screen type', async () => {
    const result = await service.search('login');
    expect(result.intent.screenTypes).toEqual(['login']);
    expect(result.screens.map((s) => s.screenType).sort()).toEqual(['login', 'login']);
  });

  it('as the same query plus that filter, read literally, gives the same screens', async () => {
    const interpreted = await service.search('login');
    const explicit = await service.search('login', 50, 0, { screenType: ['login'] }, true);
    expect(explicit.screens.map((s) => s.id).sort()).toEqual(interpreted.screens.map((s) => s.id).sort());
  });

  it('with that filter cleared, finds every screen that mentions the word', async () => {
    const literal = await service.search('login', 50, 0, {}, true);
    expect(literal.intent.screenTypes).toEqual([]);
    expect(literal.screens.map((s) => s.screenType).sort()).toEqual(['login', 'login', 'settings']);
    expect(literal.facets?.screenTypes).toEqual({ login: 2, settings: 1 });
  });
});

describe('screenshot text: saved word positions', () => {
  let tmp: string;
  let loader: LoaderService;
  let service: InspirationsService;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-words-'));
    const dataRoot = join(tmp, 'data');
    mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });
    const config = { get: (key: string) => (key === 'dataRoot' ? dataRoot : undefined) } as unknown as ConfigService;
    loader = new LoaderService(config);
    const admin = new InspirationsAdminService(config, loader);
    service = new InspirationsService(loader);
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.uploadScreen('ios', 'mobi', 'home.png', PNG_1X1, false, '');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('are read back instead of reading the image again', async () => {
    const box = { text: 'password', left: 10, top: 40, width: 20, height: 3 };
    await loader.saveWords('mobi-ios-home', [box], 'enter your password');
    expect(await loader.getWords('mobi-ios-home')).toMatchObject({ screenId: 'mobi-ios-home', words: [box] });

    // The 1×1 test image has no readable text, so a match and its highlight can only come from the saved record.
    const result = await service.searchScreenshotText('password');
    expect(result.screens.map((s) => s.id)).toEqual(['mobi-ios-home']);
    expect(result.textHighlights['mobi-ios-home']).toEqual([{ left: 10, top: 40, width: 20, height: 3 }]);
  });

  it('ignores a record saved in an older shape', async () => {
    await loader.saveWords('mobi-ios-home', [], 'x');
    const file = join(tmp, 'data', 'inspirations', 'words', 'mobi-ios-home.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...record, version: 0 }));
    expect(await loader.getWords('mobi-ios-home')).toBeNull();
  });
});
