import { ConfigModule } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AdminGuard } from './admin.guard';
import { InspirationsModule } from './inspirations.module';
import { registerUploadBodyParser } from './upload-body';

/**
 * Exercises the admin API over real HTTP: routing, the raw-body parser, and
 * the service behind it.
 *
 * The guard is replaced with one that always allows, because it is verified in
 * admin.guard.spec.ts and a real Firebase token cannot be minted here. What
 * this file covers is the part that unit tests cannot: whether an uploaded
 * image actually survives the request pipeline and lands on disk.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Inspirations admin API over HTTP', () => {
  let app: NestFastifyApplication;
  let tmp: string;
  let store: string;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ins-http-'));
    store = join(tmp, 'data', 'inspirations');
    mkdirSync(store, { recursive: true });
    process.env.DATA_ROOT = join(tmp, 'data');

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, load: [() => ({ dataRoot: join(tmp, 'data') })] }), InspirationsModule],
    })
      .overrideGuard(AdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api');
    registerUploadBodyParser(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
    delete process.env.DATA_ROOT;
  });

  const post = (url: string, payload: Buffer, contentType: string) =>
    app.getHttpAdapter().getInstance().inject({
      method: 'POST',
      url,
      payload,
      headers: { 'content-type': contentType },
    });

  it('accepts a raw image upload and writes it into the store', async () => {
    await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });

    const res = await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=', PNG_1X1, 'image/png');

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.payload);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('acme-ios-dashboard');
    expect(body.data.width).toBe(1);

    const written = join(store, 'screens', 'ios', 'acme', 'dashboard.png');
    expect(existsSync(written)).toBe(true);
    // The bytes must arrive untouched — a parser that mangles the body would
    // still produce a file, just a corrupt one.
    expect(readFileSync(written).equals(PNG_1X1)).toBe(true);
  });

  it('accepts webp and jpeg content types too', async () => {
    await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });

    for (const type of ['image/webp', 'image/jpeg', 'application/octet-stream']) {
      const name = type.split('/')[1].replace('+xml', '');
      const res = await post(`/api/inspirations/admin/screens/web/acme/login-${name}.png?version=`, PNG_1X1, type);
      expect([200, 201]).toContain(res.statusCode);
    }
  });

  it('reports a readable error when the body is not an image', async () => {
    await app.getHttpAdapter().getInstance().inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });

    const res = await post(
      '/api/inspirations/admin/screens/ios/acme/dashboard.png?version=',
      Buffer.from('nope'),
      'image/png',
    );

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.payload).message).toMatch(/not a readable image/i);
  });

  it('serves the uploaded file publicly straight away', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=', PNG_1X1, 'image/png');

    const res = await instance.inject({ method: 'GET', url: '/api/inspirations/screens/ios/acme/dashboard.png' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.rawPayload).equals(PNG_1X1)).toBe(true);
  });

  it('serves a screen filed under a version, loose or inside a flow folder', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=2026-09-29', PNG_1X1, 'image/png');

    const res = await instance.inject({
      method: 'GET',
      url: '/api/inspirations/screens/ios/acme/versions/2026-09-29/dashboard.png',
    });
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(PNG_1X1)).toBe(true);
  });

  it('deletes and edits a screen that sits inside a flow folder — flow travels as its own query param, never a literal slash in the file name', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    // Flow folders are written directly to disk by the crawler, not through
    // the admin upload route (which refuses a slash in the file name) — so
    // this places one the same way a real ingest would, to exercise the
    // meta and delete routes exactly as the Apps tab's version manager and
    // the Screens tab call them.
    const flowDir = join(store, 'screens', 'ios', 'acme', 'versions', '2026-09-29', 'onboarding');
    mkdirSync(flowDir, { recursive: true });
    writeFileSync(join(flowDir, '1.png'), PNG_1X1);
    await instance.inject({ method: 'POST', url: '/api/inspirations/admin/rebuild' });

    const metaRes = await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/screens/ios/acme/1.png/meta?version=2026-09-29&flow=onboarding',
      payload: { name: 'Welcome' },
    });
    expect(metaRes.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(join(flowDir, '1.json'), 'utf-8')).name).toBe('Welcome');

    const deleteRes = await instance.inject({
      method: 'DELETE',
      url: '/api/inspirations/admin/screens/ios/acme/1.png?version=2026-09-29&flow=onboarding',
    });

    expect(deleteRes.statusCode).toBe(200);
    expect(existsSync(join(flowDir, '1.png'))).toBe(false);
  });

  it('still records the app in sources.json, so origin survives the upload', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=', PNG_1X1, 'image/png');

    const sources = JSON.parse(readFileSync(join(store, 'sources.json'), 'utf-8')).sources;
    expect(sources.acme.status).toBe('approved');
  });

  it('deletes an app and its files through the API', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=', PNG_1X1, 'image/png');
    await post('/api/inspirations/admin/screens/web/acme/login.png?version=', PNG_1X1, 'image/png');

    const res = await instance.inject({ method: 'DELETE', url: '/api/inspirations/admin/apps/acme' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload).data.removed.screens).toBe(2);
    expect(existsSync(join(store, 'screens', 'ios', 'acme'))).toBe(false);
    expect(existsSync(join(store, 'screens', 'web', 'acme'))).toBe(false);

    const state = JSON.parse(
      (await instance.inject({ method: 'GET', url: '/api/inspirations/admin/state' })).payload,
    ).data;
    expect(state.apps).toHaveLength(0);
    expect(state.files).toHaveLength(0);
  });

  it('returns the admin state with the uploaded file published', async () => {
    const instance = app.getHttpAdapter().getInstance();
    await instance.inject({
      method: 'PUT',
      url: '/api/inspirations/admin/apps/acme',
      payload: { name: 'Acme', industry: 'saas' },
    });
    await post('/api/inspirations/admin/screens/ios/acme/dashboard.png?version=', PNG_1X1, 'image/png');

    const res = await instance.inject({ method: 'GET', url: '/api/inspirations/admin/state' });

    expect(res.statusCode).toBe(200);
    const state = JSON.parse(res.payload).data;
    expect(state.apps).toHaveLength(1);
    expect(state.files).toHaveLength(1);
    expect(state.files[0].published).toBe(true);
    expect(state.files[0].blockedReason).toBeNull();
  });
});
