import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InspirationsAdminService } from '../inspirations/inspirations-admin.service';
import { InspirationsModule } from '../inspirations/inspirations.module';
import { McpOAuthService } from '../mcp/mcp-oauth.service';
import { FIGMA_CLIENT_ID } from './figma.controller';
import { FigmaModule } from './figma.module';
import { rendition } from './figma-image.service';

const sharp: typeof import('sharp').default = require('sharp');

/**
 * The Figma plugin's API over real HTTP: signing in by pairing, searching one
 * platform at a time, and images in parts Figma accepts.
 *
 * The Firebase verifier is primed with a key pair generated here, as in
 * mcp.http.spec.ts.
 */

const PROJECT_ID = 'motvin-test';
const KID = 'test-kid';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function firebaseToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-123',
    iat: now,
    exp: now + 3600,
    email: 'Person@Example.com',
    name: 'A Person',
    firebase: { sign_in_provider: 'google.com' },
    ...overrides,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: KID })}.${encode(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

describe('Figma plugin API over HTTP', () => {
  let app: NestFastifyApplication;
  let tmp: string;

  const inject = (options: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; payload?: unknown }) =>
    app.getHttpAdapter().getInstance().inject(options as never);
  const get = (token: string, url: string) => inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  /** The plugin's sign-in: a secret key, its hash in the link, approval, then the claim. */
  async function signIn(person: Record<string, unknown> = {}) {
    const key = randomBytes(32).toString('hex');
    const pair = createHash('sha256').update(key).digest('hex');
    const waiting = await inject({ method: 'POST', url: '/api/figma/pair/claim', payload: { key } });
    expect(waiting.json().data).toEqual({ status: 'waiting' });

    const approved = await inject({ method: 'POST', url: '/api/figma/pair/approve', payload: { pair, idToken: firebaseToken(person) } });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().data.code).toBe(`${pair.slice(0, 3).toUpperCase()}-${pair.slice(3, 6).toUpperCase()}`);

    const claimed = await inject({ method: 'POST', url: '/api/figma/pair/claim', payload: { key } });
    return { key, pair, body: claimed.json().data };
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'figma-http-'));
    const dataRoot = join(tmp, 'data');
    mkdirSync(join(dataRoot, 'inspirations'), { recursive: true });

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              dataRoot,
              nodeEnv: 'test',
              firebase: { projectId: PROJECT_ID },
              admin: { emails: ['admin@example.com'] },
              mcp: {
                secret: 'test-secret',
                issuer: 'http://api.test',
                connectUrl: 'http://web.test/mcp/connect',
                siteUrl: 'http://web.test',
                rateLimits: { callsPerMinute: 0, callsPerDay: 0, previewsPerMinute: 0, oauthPerMinute: 0 },
              },
            }),
          ],
        }),
        InspirationsModule,
        FigmaModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', { exclude: ['.well-known/(.*)'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const verifier = (app.get(McpOAuthService) as unknown as { verifier: { certs: Record<string, string>; certsExpireAt: number } }).verifier;
    verifier.certs = { [KID]: CERT_PEM };
    verifier.certsExpireAt = Date.now() + 60_000;

    const picture = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: '#4060ff' } }).png().toBuffer();
    const admin = app.get(InspirationsAdminService);
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.saveApp({ id: 'webby', name: 'Webby', industry: 'productivity' });
    admin.uploadScreen('ios', 'mobi', 'home.png', await picture(1170, 2532), false, '');
    admin.uploadScreen('ios', 'mobi', 'cart.png', await picture(1170, 2532), false, '');
    admin.uploadScreen('webapp', 'webby', 'home.png', await picture(2880, 1800), false, '');
    admin.saveScreenMeta('ios', 'mobi', 'home.png', { screenType: 'home' });
    admin.saveScreenMeta('ios', 'mobi', 'cart.png', { screenType: 'cart' });
    admin.saveScreenMeta('webapp', 'webby', 'home.png', { screenType: 'home' });
    admin.saveFlow({ id: 'mobi-checkout', appId: 'mobi', name: 'Checkout', category: 'checkout', platform: 'ios', screenIds: ['mobi-ios-home', 'mobi-ios-cart'] });

    // A website's very tall whole page: more than one 4096px part.
    admin.saveApp({ id: 'sity', name: 'Sity', industry: 'productivity' });
    const version = join(dataRoot, 'inspirations', 'screens', 'site', 'sity', 'versions', '2026-11-25');
    mkdirSync(join(version, 'pages'), { recursive: true });
    writeFileSync(join(version, 'pages', '1.webp'), await sharp({ create: { width: 1440, height: 9000, channels: 3, background: '#ffffff' } }).webp().toBuffer());
    writeFileSync(join(version, 'pages', '1.json'), JSON.stringify({ name: 'Pricing Page', screenType: 'pricing', fineType: 'pricing', kind: 'page', pageType: 'pricing', pageUrl: 'https://sity.test/pricing', title: 'Pricing', order: 1 }));
    admin.rebuild();
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('signing in', () => {
    it('hands the tokens over once, to the key whose hash was approved', async () => {
      const { key, body } = await signIn();
      expect(body.status).toBe('ready');
      expect(body.email).toBe('person@example.com');
      expect(body.client_id).toBe(FIGMA_CLIENT_ID);
      expect(body.access_token).toEqual(expect.any(String));

      const again = await inject({ method: 'POST', url: '/api/figma/pair/claim', payload: { key } });
      expect(again.json().data).toEqual({ status: 'waiting' });
    });

    it('cannot be claimed with the pair from the link', async () => {
      const key = randomBytes(32).toString('hex');
      const pair = createHash('sha256').update(key).digest('hex');
      await inject({ method: 'POST', url: '/api/figma/pair/approve', payload: { pair, idToken: firebaseToken() } });
      const withPair = await inject({ method: 'POST', url: '/api/figma/pair/claim', payload: { key: pair } });
      expect(withPair.json().data).toEqual({ status: 'waiting' });
    });

    it('refuses guests and broken links', async () => {
      const pair = createHash('sha256').update('x').digest('hex');
      const guest = await inject({ method: 'POST', url: '/api/figma/pair/approve', payload: { pair, idToken: firebaseToken({ firebase: { sign_in_provider: 'anonymous' } }) } });
      expect(guest.statusCode).toBe(403);
      const broken = await inject({ method: 'POST', url: '/api/figma/pair/approve', payload: { pair: 'abc', idToken: firebaseToken() } });
      expect(broken.statusCode).toBe(400);
    });

    it('is an ordinary connection: refreshed at /token, listed, and dead once revoked', async () => {
      const { body } = await signIn();
      const refreshed = await inject({
        method: 'POST',
        url: '/api/mcp/oauth/token',
        payload: { grant_type: 'refresh_token', refresh_token: body.refresh_token, client_id: FIGMA_CLIENT_ID },
      });
      expect(refreshed.statusCode).toBe(200);
      const access = refreshed.json().access_token as string;
      expect((await get(access, '/api/figma/meta?platform=ios')).statusCode).toBe(200);

      const listed = app.get(McpOAuthService).listConnections('uid-123');
      expect(listed.map((c) => c.client_name)).toContain('Figma — Motvin Inspiration');

      await inject({ method: 'POST', url: '/api/mcp/oauth/revoke', payload: { token: refreshed.json().refresh_token } });
      expect((await get(access, '/api/figma/meta?platform=ios')).statusCode).toBe(401);
    });
  });

  describe('the library', () => {
    let token: string;
    beforeAll(async () => {
      token = (await signIn()).body.access_token;
    });

    it('lets anyone browse, but only a signed-in person put screens on the canvas', async () => {
      const browse = await inject({ method: 'GET', url: '/api/figma/screens?platform=ios' });
      expect(browse.statusCode).toBe(200);
      expect(browse.json().data.screens.length).toBe(2);
      expect((await inject({ method: 'GET', url: '/api/figma/flow/mobi-checkout' })).statusCode).toBe(200);
      expect((await inject({ method: 'GET', url: '/api/figma/thumb/mobi-ios-home' })).statusCode).toBe(200);
      expect((await inject({ method: 'GET', url: '/api/figma/image/mobi-ios-home' })).statusCode).toBe(401);
      // A token that is sent but no good is refused, so the plugin knows to refresh it.
      expect((await get('not-a-token', '/api/figma/screens?platform=ios')).statusCode).toBe(401);
      expect((await get('not-a-token', '/api/figma/thumb/mobi-ios-home')).statusCode).toBe(401);
    });

    it('keeps every list to one platform', async () => {
      const ios = (await get(token, '/api/figma/screens?platform=ios')).json().data;
      expect(ios.screens.length).toBe(2);
      expect(ios.screens.every((s: { platform: string }) => s.platform === 'ios')).toBe(true);

      const web = (await get(token, '/api/figma/screens?platform=webapp&q=home')).json().data;
      expect(web.screens.map((s: { id: string }) => s.id)).toEqual(['webby-webapp-home']);

      const mixed = (await get(token, '/api/figma/resolve?platform=ios&ids=mobi-ios-home,webby-webapp-home')).json().data;
      expect(mixed.screens.map((s: { id: string }) => s.id)).toEqual(['mobi-ios-home']);
      expect(mixed.missing).toBe(1);

      expect((await get(token, '/api/figma/screens?platform=web')).statusCode).toBe(400);
      expect((await get(token, '/api/figma/screens?platform=ios&app=webby')).statusCode).toBe(404);
    });

    it('narrows to several apps at once, for the colour filter', async () => {
      const some = (await get(token, '/api/figma/screens?platform=ios&apps=mobi,webby')).json().data;
      expect(some.screens.every((s: { app: { id: string } }) => s.app.id === 'mobi')).toBe(true);
      expect(some.total).toBe(2);
      const searched = (await get(token, '/api/figma/screens?platform=ios&q=home&apps=mobi')).json().data;
      expect(searched.screens.map((s: { id: string }) => s.id)).toEqual(['mobi-ios-home']);
      // A colour no app on this platform has: nothing, not everything.
      expect((await get(token, '/api/figma/screens?platform=ios&apps=')).json().data.total).toBe(0);
      expect((await get(token, '/api/figma/flows?platform=ios&apps=webby')).json().data.total).toBe(0);
      expect((await get(token, '/api/figma/flows?platform=ios&apps=mobi')).json().data.total).toBe(1);
    });

    it('sizes frames in design points', async () => {
      const ios = (await get(token, '/api/figma/screens?platform=ios')).json().data.screens[0];
      expect(ios.image.frame).toEqual({ width: 390, height: 844 });
      const web = (await get(token, '/api/figma/screens?platform=webapp')).json().data.screens[0];
      expect(web.image.frame).toEqual({ width: 1440, height: 900 });
    });

    it('gives a flow step by step', async () => {
      const flows = (await get(token, '/api/figma/flows?platform=ios')).json().data;
      expect(flows.flows.map((f: { id: string }) => f.id)).toEqual(['mobi-checkout']);
      const flow = (await get(token, '/api/figma/flow/mobi-checkout')).json().data;
      expect(flow.steps.map((s: { position: number; id: string }) => [s.position, s.id])).toEqual([
        [1, 'mobi-ios-home'],
        [2, 'mobi-ios-cart'],
      ]);
      expect((await get(token, '/api/figma/flows?platform=site')).statusCode).toBe(400);
    });

    it('sends a tall page as JPEG parts that stack to the size it promised', async () => {
      const page = (await get(token, '/api/figma/screens?platform=site')).json().data.screens[0];
      expect(page.screen_type).toBe('pricing page');
      expect(page.image.parts).toBeGreaterThan(1);

      let stacked = 0;
      for (let part = 0; part < page.image.parts; part++) {
        const res = await get(token, `/api/figma/image/${page.id}?part=${part}`);
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toBe('image/jpeg');
        const meta = await sharp(res.rawPayload).metadata();
        expect(meta.width).toBe(page.image.width);
        expect(meta.height).toBeLessThanOrEqual(4096);
        stacked += meta.height ?? 0;
      }
      expect(stacked).toBe(page.image.height);
      expect((await get(token, `/api/figma/image/${page.id}?part=${page.image.parts}`)).statusCode).toBe(404);
    });
  });

  describe('rendition', () => {
    it('keeps view-only screens at preview size', () => {
      expect(rendition({ width: 1170, height: 2532, platform: 'ios', downloadable: false })).toMatchObject({ width: 720, full: false, parts: 1 });
      expect(rendition({ width: 1170, height: 2532, platform: 'ios', downloadable: true })).toMatchObject({ width: 1170, full: true });
      expect(rendition({ width: 6000, height: 1000, platform: 'webapp', downloadable: true }).width).toBe(4096);
    });
  });
});
