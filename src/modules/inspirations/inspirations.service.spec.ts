import { ConfigService } from '@nestjs/config';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
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
