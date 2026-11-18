import { ConfigModule, ConfigService } from '@nestjs/config';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { InspirationsAdminService } from '../inspirations/inspirations-admin.service';
import { AdminGuard } from '../inspirations/admin.guard';
import { InspirationsModule } from '../inspirations/inspirations.module';
import { McpOAuthService } from './mcp-oauth.service';
import { McpRateLimitService } from './mcp-rate-limit.service';
import { McpModule } from './mcp.module';

/**
 * The MCP server over real HTTP, the way a client meets it: discovery at the
 * origin root, a 401 that points at discovery, the OAuth dance from
 * registration to a refreshed token, and tool calls that honour the platform
 * rule.
 *
 * Google's signing keys cannot be used here, so the Firebase verifier inside
 * the OAuth service is primed with a key pair generated in this file — the
 * same arrangement admin.guard.spec.ts uses.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const ISSUER = 'http://api.test';
const CONNECT_URL = 'http://web.test/mcp/connect';
const SITE_URL = 'http://web.test';
const PROJECT_ID = 'motvin-test';
const KID = 'test-kid';
const REDIRECT_URI = 'http://localhost:6274/oauth/callback';

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
    email: 'person@example.com',
    email_verified: true,
    name: 'A Person',
    firebase: { sign_in_provider: 'google.com' },
    ...overrides,
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'RS256', kid: KID })}.${encode(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

describe('Motvin MCP over HTTP', () => {
  let app: NestFastifyApplication;
  let tmp: string;

  const inject = (options: { method: 'GET' | 'POST' | 'DELETE'; url: string; headers?: Record<string, string>; payload?: unknown }) =>
    app.getHttpAdapter().getInstance().inject(options as never);

  const rpc = (token: string, method: string, params: unknown, id = 1) =>
    inject({
      method: 'POST',
      url: '/api/mcp',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: { jsonrpc: '2.0', id, method, params },
    });

  const callTool = async (token: string, name: string, args: Record<string, unknown>) => {
    const res = await rpc(token, 'tools/call', { name, arguments: args });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.error).toBeUndefined();
    return body.result as { content: { type: string; text?: string }[]; structuredContent: any; isError?: boolean };
  };

  /** Registration → authorization → approval → code exchange, as a client does it. */
  async function connect(person: Record<string, unknown> = {}): Promise<{ clientId: string; tokens: Record<string, any> }> {
    const registered = await inject({
      method: 'POST',
      url: '/api/mcp/oauth/register',
      payload: { client_name: 'Test Client', redirect_uris: [REDIRECT_URI], grant_types: ['authorization_code', 'refresh_token'] },
    });
    expect(registered.statusCode).toBe(201);
    const clientId = registered.json().client_id as string;

    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorize = await inject({
      method: 'GET',
      url:
        `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
    });
    expect(authorize.statusCode).toBe(302);
    const connectUrl = new URL(authorize.headers.location as string);
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(CONNECT_URL);
    const request = connectUrl.searchParams.get('request') as string;

    const approve = await inject({ method: 'POST', url: '/api/mcp/oauth/approve', payload: { request, idToken: firebaseToken(person), decision: 'allow' } });
    expect(approve.statusCode).toBe(200);
    const back = new URL(approve.json().data.redirectTo);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT_URI);
    expect(back.searchParams.get('state')).toBe('xyz');

    const token = await inject({
      method: 'POST',
      url: '/api/mcp/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: back.searchParams.get('code') as string,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    return { clientId, tokens: token.json() };
  }

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-http-'));
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
              // Rate limits off for the suite; the rate-limit tests switch them on one at a time.
              mcp: {
                secret: 'test-secret',
                issuer: ISSUER,
                connectUrl: CONNECT_URL,
                siteUrl: SITE_URL,
                rateLimits: { callsPerMinute: 0, callsPerDay: 0, previewsPerMinute: 0, oauthPerMinute: 0 },
              },
            }),
          ],
        }),
        InspirationsModule,
        McpModule,
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.setGlobalPrefix('api', { exclude: ['.well-known/(.*)'] });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const oauth = app.get(McpOAuthService);
    const verifier = (oauth as unknown as { verifier: { certs: Record<string, string>; certsExpireAt: number } }).verifier;
    verifier.certs = { [KID]: CERT_PEM };
    verifier.certsExpireAt = Date.now() + 60_000;
    // The admin guard (MCP usage report) verifies with its own copy.
    const adminVerifier = (app.get(AdminGuard) as unknown as { verifier: { certs: Record<string, string>; certsExpireAt: number } }).verifier;
    adminVerifier.certs = { [KID]: CERT_PEM };
    adminVerifier.certsExpireAt = Date.now() + 60_000;

    // A phone app and a website, so the platform rule has something to separate.
    const admin = app.get(InspirationsAdminService);
    admin.saveApp({ id: 'mobi', name: 'Mobi', industry: 'food' });
    admin.saveApp({ id: 'webby', name: 'Webby', industry: 'productivity' });
    admin.uploadScreen('ios', 'mobi', 'home.png', PNG_1X1, false, '');
    admin.uploadScreen('ios', 'mobi', 'cart.png', PNG_1X1, false, '');
    admin.uploadScreen('web', 'webby', 'home.png', PNG_1X1, false, '');
    admin.uploadScreen('web', 'webby', 'pricing.png', PNG_1X1, false, '');
    admin.saveScreenMeta('ios', 'mobi', 'home.png', { screenType: 'home', elements: ['tab-bar'] });
    admin.saveScreenMeta('ios', 'mobi', 'cart.png', { screenType: 'cart', elements: ['tab-bar', 'button'] });
    admin.saveScreenMeta('web', 'webby', 'home.png', { screenType: 'home', elements: ['nav-bar'] });
    admin.saveScreenMeta('web', 'webby', 'pricing.png', { screenType: 'pricing', elements: ['nav-bar', 'price'] });
    admin.saveFlow({ id: 'mobi-checkout', appId: 'mobi', name: 'Checkout', category: 'checkout', platform: 'ios', screenIds: ['mobi-ios-home', 'mobi-ios-cart'] });
    admin.saveFlow({ id: 'webby-pricing', appId: 'webby', name: 'Choosing a plan', category: 'checkout', platform: 'web', screenIds: ['webby-web-home', 'webby-web-pricing'] });
  });

  afterAll(async () => {
    await app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('discovery', () => {
    it('serves the protected-resource document at the origin root', async () => {
      const res = await inject({ method: 'GET', url: '/.well-known/oauth-protected-resource/api/mcp' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ resource: `${ISSUER}/api/mcp`, authorization_servers: [ISSUER] });
    });

    it('serves the authorization-server document with every endpoint under /api/mcp/oauth', async () => {
      const res = await inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/api/mcp/oauth/authorize`,
        token_endpoint: `${ISSUER}/api/mcp/oauth/token`,
        registration_endpoint: `${ISSUER}/api/mcp/oauth/register`,
        code_challenge_methods_supported: ['S256'],
        client_id_metadata_document_supported: true,
      });
    });

    it('answers an unauthenticated MCP request with a 401 that names the discovery document', async () => {
      const res = await inject({ method: 'POST', url: '/api/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
    });
  });

  describe('authorization', () => {
    it('takes a client from registration to a usable token, and refreshes it', async () => {
      const { clientId, tokens } = await connect();
      expect(tokens).toMatchObject({ token_type: 'Bearer', scope: 'inspirations:read' });
      expect(typeof tokens.access_token).toBe('string');
      expect(typeof tokens.refresh_token).toBe('string');

      const listed = await rpc(tokens.access_token, 'tools/list', {});
      expect(listed.statusCode).toBe(200);
      expect(listed.json().result.tools.map((t: { name: string }) => t.name)).toEqual(
        expect.arrayContaining(['search_screens', 'search_flows', 'get_screen', 'get_taxonomy']),
      );

      const refreshed = await inject({
        method: 'POST',
        url: '/api/mcp/oauth/token',
        payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId },
      });
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().access_token).not.toBe(tokens.access_token);

      // Rotation: the refresh token that was just used is dead.
      const reused = await inject({
        method: 'POST',
        url: '/api/mcp/oauth/token',
        payload: { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: clientId },
      });
      expect(reused.statusCode).toBe(400);
      expect(reused.json().error).toBe('invalid_grant');
    });

    it('tells the connect page who is asking', async () => {
      const registered = await inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { client_name: 'Cursor', redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] } });
      const challenge = createHash('sha256').update('verifier').digest('base64url');
      const authorize = await inject({
        method: 'GET',
        url: `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(registered.json().client_id)}&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      const request = new URL(authorize.headers.location as string).searchParams.get('request') as string;
      const described = await inject({ method: 'GET', url: `/api/mcp/oauth/request?request=${encodeURIComponent(request)}` });
      expect(described.statusCode).toBe(200);
      expect(described.json().data).toMatchObject({ client_name: 'Cursor', destination: 'cursor://' });
    });

    it('refuses an unregistered redirect_uri before redirecting anywhere', async () => {
      const registered = await inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { redirect_uris: [REDIRECT_URI] } });
      const res = await inject({
        method: 'GET',
        url: `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(registered.json().client_id)}&redirect_uri=${encodeURIComponent('https://evil.example/cb')}&code_challenge=x&code_challenge_method=S256`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_request');
    });

    it('sends a missing PKCE challenge back to the client as an OAuth error', async () => {
      const registered = await inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { redirect_uris: [REDIRECT_URI] } });
      const res = await inject({
        method: 'GET',
        url: `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(registered.json().client_id)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=s1`,
      });
      expect(res.statusCode).toBe(302);
      const back = new URL(res.headers.location as string);
      expect(back.origin + back.pathname).toBe(REDIRECT_URI);
      expect(back.searchParams.get('error')).toBe('invalid_request');
      expect(back.searchParams.get('state')).toBe('s1');
    });

    it('will not connect a guest session', async () => {
      const registered = await inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { redirect_uris: [REDIRECT_URI] } });
      const challenge = createHash('sha256').update('verifier').digest('base64url');
      const authorize = await inject({
        method: 'GET',
        url: `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(registered.json().client_id)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      const request = new URL(authorize.headers.location as string).searchParams.get('request') as string;
      const res = await inject({
        method: 'POST',
        url: '/api/mcp/oauth/approve',
        payload: { request, decision: 'allow', idToken: firebaseToken({ email: undefined, firebase: { sign_in_provider: 'anonymous' } }) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('access_denied');
    });

    it('rejects a wrong PKCE verifier and a reused code', async () => {
      const registered = await inject({ method: 'POST', url: '/api/mcp/oauth/register', payload: { redirect_uris: [REDIRECT_URI] } });
      const clientId = registered.json().client_id as string;
      const verifier = 'the-right-verifier';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const authorize = await inject({
        method: 'GET',
        url: `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`,
      });
      const request = new URL(authorize.headers.location as string).searchParams.get('request') as string;
      const approve = await inject({ method: 'POST', url: '/api/mcp/oauth/approve', payload: { request, idToken: firebaseToken(), decision: 'allow' } });
      const code = new URL(approve.json().data.redirectTo).searchParams.get('code') as string;

      const wrong = await inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: clientId } });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toBe('invalid_grant');

      const right = await inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId } });
      expect(right.statusCode).toBe(200);

      const again = await inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId } });
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe('invalid_grant');
    });

    it('rejects a token signed with another secret', async () => {
      const res = await rpc('not.a.token', 'tools/list', {});
      expect(res.statusCode).toBe(401);
    });
  });

  describe('client ID metadata documents (CIMD)', () => {
    const CLIENT_URL = 'https://tool.example/oauth/client.json';
    let oauth: McpOAuthService;
    let original: McpOAuthService['fetchClientMetadata'];
    let documents: Record<string, unknown>;

    beforeAll(() => {
      oauth = app.get(McpOAuthService);
      original = oauth.fetchClientMetadata;
      oauth.fetchClientMetadata = async (url) => {
        if (!(url in documents)) throw new Error('404');
        return documents[url];
      };
    });
    afterAll(() => {
      oauth.fetchClientMetadata = original;
    });

    const authorizeWith = (clientId: string, challenge = 'c') =>
      inject({
        method: 'GET',
        url:
          `/api/mcp/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz`,
      });

    it('connects a client whose client_id is its metadata URL, with no registration', async () => {
      documents = { [CLIENT_URL]: { client_id: CLIENT_URL, client_name: 'Metadata Tool', redirect_uris: [REDIRECT_URI] } };
      const verifier = randomBytes(32).toString('base64url');
      const authorize = await authorizeWith(CLIENT_URL, createHash('sha256').update(verifier).digest('base64url'));
      expect(authorize.statusCode).toBe(302);
      const request = new URL(authorize.headers.location as string).searchParams.get('request') as string;

      const described = await inject({ method: 'GET', url: `/api/mcp/oauth/request?request=${encodeURIComponent(request)}` });
      expect(described.json().data).toMatchObject({ client_name: 'Metadata Tool' });

      const approve = await inject({ method: 'POST', url: '/api/mcp/oauth/approve', payload: { request, idToken: firebaseToken(), decision: 'allow' } });
      const back = new URL(approve.json().data.redirectTo);
      const token = await inject({
        method: 'POST',
        url: '/api/mcp/oauth/token',
        payload: { grant_type: 'authorization_code', code: back.searchParams.get('code'), code_verifier: verifier, client_id: CLIENT_URL, redirect_uri: REDIRECT_URI },
      });
      expect(token.statusCode).toBe(200);
      const listed = await rpc(token.json().access_token, 'tools/list', {});
      expect(listed.statusCode).toBe(200);
    });

    it('refuses a document whose client_id is not its own URL', async () => {
      documents = { [CLIENT_URL]: { client_id: 'https://someone-else.example/client.json', redirect_uris: [REDIRECT_URI] } };
      oauth['metadataClients'].clear();
      const res = await authorizeWith(CLIENT_URL);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_client');
    });

    it('refuses a redirect_uri the document does not list, before redirecting anywhere', async () => {
      documents = { [CLIENT_URL]: { client_id: CLIENT_URL, redirect_uris: ['https://tool.example/other-callback'] } };
      oauth['metadataClients'].clear();
      const res = await authorizeWith(CLIENT_URL);
      expect(res.statusCode).toBe(400);
      expect(res.headers.location).toBeUndefined();
    });

    it('refuses a document it cannot fetch', async () => {
      documents = {};
      oauth['metadataClients'].clear();
      const res = await authorizeWith('https://tool.example/missing.json');
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_client');
    });
  });

  describe('disconnecting', () => {
    const revoke = (token: string) => inject({ method: 'POST', url: '/api/mcp/oauth/revoke', payload: { token } });
    const refresh = (clientId: string, refreshToken: string) =>
      inject({ method: 'POST', url: '/api/mcp/oauth/token', payload: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId } });

    it('cuts the access token at once, not when its hour runs out', async () => {
      const { clientId, tokens } = await connect();
      expect((await rpc(tokens.access_token, 'tools/list', {})).statusCode).toBe(200);

      const res = await revoke(tokens.refresh_token);
      expect(res.statusCode).toBe(200);

      expect((await rpc(tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
      const again = await refresh(clientId, tokens.refresh_token);
      expect(again.statusCode).toBe(400);
      expect(again.json().error).toBe('invalid_grant');
    });

    it('ends the whole connection, including tokens it got from refreshing', async () => {
      const { clientId, tokens } = await connect();
      const next = (await refresh(clientId, tokens.refresh_token)).json();
      expect((await rpc(next.access_token, 'tools/list', {})).statusCode).toBe(200);

      // Revoking the first, already-replaced access token still ends the connection.
      await revoke(tokens.access_token);

      expect((await rpc(next.access_token, 'tools/list', {})).statusCode).toBe(401);
      expect((await refresh(clientId, next.refresh_token)).statusCode).toBe(400);
    });

    it('leaves other connections of the same person alone', async () => {
      const first = await connect();
      const second = await connect();
      await revoke(first.tokens.refresh_token);

      expect((await rpc(first.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
      expect((await rpc(second.tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
    });

    it('stays disconnected after a restart', async () => {
      const { tokens } = await connect();
      await revoke(tokens.refresh_token);

      // A fresh service reads the same revocation file, as the API does when it boots.
      const restarted = new McpOAuthService(app.get(ConfigService));
      expect(restarted.verifyAccessToken(tokens.access_token)).toBeNull();

      const other = await connect();
      expect(restarted.verifyAccessToken(other.tokens.access_token)).not.toBeNull();
    });

    it('answers 200 for a token it does not know, as RFC 7009 asks', async () => {
      const res = await revoke('not.a.token');
      expect(res.statusCode).toBe(200);
    });
  });

  describe('tools', () => {
    let token: string;

    beforeAll(async () => {
      token = (await connect()).tokens.access_token;
    });

    it('search_screens returns one platform only, with a preview per screen', async () => {
      const ios = await callTool(token, 'search_screens', { query: 'home', platform: 'ios' });
      expect(ios.isError).toBeFalsy();
      expect(ios.structuredContent.platform).toBe('ios');
      expect(ios.structuredContent.screens.length).toBeGreaterThan(0);
      expect(ios.structuredContent.screens.every((s: { platform: string }) => s.platform === 'ios')).toBe(true);
      expect(ios.content.some((c) => c.type === 'image')).toBe(true);
      expect(ios.structuredContent.screens[0].page_url).toBe(`${SITE_URL}/inspirations/screens?screen=mobi-ios-home`);

      const web = await callTool(token, 'search_screens', { query: 'home', platform: 'web' });
      expect(web.structuredContent.screens.every((s: { platform: string }) => s.platform === 'web')).toBe(true);
      expect(web.structuredContent.screens.map((s: { id: string }) => s.id)).toContain('webby-web-home');
      expect(web.structuredContent.screens.map((s: { id: string }) => s.id)).not.toContain('mobi-ios-home');
    });

    it('search_screens with images off is text only', async () => {
      const res = await callTool(token, 'search_screens', { query: 'home', platform: 'ios', include_images: false });
      expect(res.content.every((c) => c.type === 'text')).toBe(true);
    });

    it('search_screens says so when a platform has nothing matching', async () => {
      const res = await callTool(token, 'search_screens', { query: 'pricing', platform: 'ios' });
      expect(res.structuredContent.screens).toEqual([]);
      expect(res.content[0].text).toContain('No iOS screens match');
    });

    it('find_similar_screens stays on the screen’s platform', async () => {
      const res = await callTool(token, 'find_similar_screens', { screen_id: 'mobi-ios-home' });
      expect(res.structuredContent.platform).toBe('ios');
      expect(res.structuredContent.screens.every((s: { platform: string }) => s.platform === 'ios')).toBe(true);
    });

    it('search_flows and get_flow walk a journey on one platform', async () => {
      const flows = await callTool(token, 'search_flows', { platform: 'web', category: 'checkout' });
      expect(flows.structuredContent.flows.map((f: { id: string }) => f.id)).toEqual(['webby-pricing']);

      const flow = await callTool(token, 'get_flow', { flow_id: 'webby-pricing' });
      expect(flow.structuredContent.steps.map((s: { id: string }) => s.id)).toEqual(['webby-web-home', 'webby-web-pricing']);
      expect(flow.structuredContent.steps[0].position).toBe(1);
    });

    it('get_taxonomy narrows to the platform asked for', async () => {
      const res = await callTool(token, 'get_taxonomy', { platform: 'web' });
      expect(res.structuredContent.screen_types.sort()).toEqual(['home', 'pricing']);
      expect(res.structuredContent.elements).toEqual(expect.arrayContaining(['nav-bar', 'price']));
      expect(res.structuredContent.elements).not.toContain('tab-bar');
    });

    it('get_app refuses a platform the app was not captured on', async () => {
      const res = await callTool(token, 'get_app', { app: 'mobi', platform: 'web' });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not captured on Webs');
    });

    it('get_screen carries the full record and a larger preview', async () => {
      const res = await callTool(token, 'get_screen', { screen_id: 'webby-web-pricing' });
      expect(res.structuredContent.screen).toMatchObject({ id: 'webby-web-pricing', screen_type: 'pricing', platform: 'web' });
      expect(res.structuredContent.flows.map((f: { id: string }) => f.id)).toEqual(['webby-pricing']);
      expect(res.content.some((c) => c.type === 'image')).toBe(true);
    });

    it('an unknown id is a tool error, not a protocol failure', async () => {
      const res = await callTool(token, 'get_screen', { screen_id: 'nope' });
      expect(res.isError).toBe(true);
    });

    it('does not offer the standalone stream', async () => {
      const res = await inject({ method: 'GET', url: '/api/mcp', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(405);
    });
  });

  describe('rate limits', () => {
    let limiter: McpRateLimitService;
    let token: string;
    let saved: McpRateLimitService['limits'];

    beforeAll(async () => {
      limiter = app.get(McpRateLimitService);
      token = (await connect()).tokens.access_token;
    });
    beforeEach(() => {
      saved = { ...limiter.limits };
    });
    afterEach(() => {
      limiter.limits = saved;
    });

    it('turns a call over the per-minute budget into a tool error that says when to retry', async () => {
      limiter.limits = { ...saved, callsPerMinute: 2 };
      expect((await callTool(token, 'get_taxonomy', { platform: 'ios' })).isError).toBeFalsy();
      expect((await callTool(token, 'get_taxonomy', { platform: 'ios' })).isError).toBeFalsy();

      const third = await callTool(token, 'get_taxonomy', { platform: 'ios' });
      expect(third.isError).toBe(true);
      expect(third.content[0].text).toMatch(/Too many requests: Motvin allows 2 tool calls a minute per person\. Try again in \d+ seconds?\./);
    });

    it('keeps one person over budget from blocking another', async () => {
      limiter.limits = { ...saved, callsPerMinute: 1 };
      const ana = (await connect({ sub: 'uid-ana', email: 'ana@example.com' })).tokens.access_token;
      const ben = (await connect({ sub: 'uid-ben', email: 'ben@example.com' })).tokens.access_token;

      expect((await callTool(ana, 'get_taxonomy', { platform: 'ios' })).isError).toBeFalsy();
      expect((await callTool(ana, 'get_taxonomy', { platform: 'ios' })).isError).toBe(true);
      expect((await callTool(ben, 'get_taxonomy', { platform: 'ios' })).isError).toBeFalsy();
    });

    it('stops at the daily budget with its own message', async () => {
      limiter.limits = { ...saved, callsPerDay: 1 };
      const fresh = (await connect({ sub: 'uid-cleo', email: 'cleo@example.com' })).tokens.access_token;
      await callTool(fresh, 'get_taxonomy', { platform: 'web' });
      const next = await callTool(fresh, 'get_taxonomy', { platform: 'web' });
      expect(next.isError).toBe(true);
      expect(next.content[0].text).toMatch(/^Daily limit reached: Motvin allows 1 tool calls a day per person/);
    });

    it('drops previews past their budget but still answers, and says why', async () => {
      limiter.limits = { ...saved, previewsPerMinute: 1 };
      // A two-step flow wants two previews; the budget allows one.
      const result = await callTool(token, 'get_flow', { flow_id: 'mobi-checkout' });
      expect(result.isError).toBeFalsy();
      expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
      expect(result.content.some((c) => c.type === 'text' && /^Previews paused/.test(c.text ?? ''))).toBe(true);
    });

    it('answers 429 with Retry-After once an address passes the OAuth budget', async () => {
      limiter.limits = { ...saved, oauthPerMinute: 2 };
      const register = (address: string) =>
        inject({ method: 'POST', url: '/api/mcp/oauth/register', headers: { 'cf-connecting-ip': address }, payload: { redirect_uris: [REDIRECT_URI] } });

      expect((await register('203.0.113.7')).statusCode).toBe(201);
      expect((await register('203.0.113.7')).statusCode).toBe(201);
      const blocked = await register('203.0.113.7');
      expect(blocked.statusCode).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect(blocked.json().error).toBe('too_many_requests');

      // Another address is unaffected.
      expect((await register('198.51.100.9')).statusCode).toBe(201);
    });
  });


  describe('smarter search', () => {
    it('finds a screen described in other words (basket → cart)', async () => {
      const token = (await connect({ sub: 'uid-gus', email: 'gus@example.com' })).tokens.access_token;
      const result = await callTool(token, 'search_screens', { query: 'shopping basket', platform: 'ios' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.screens.map((s: { id: string }) => s.id)).toContain('mobi-ios-cart');
    });
  });

  describe('connected tools (settings page)', () => {
    const list = (person: Record<string, unknown>) =>
      inject({ method: 'GET', url: '/api/mcp/connections', headers: { authorization: `Bearer ${firebaseToken(person)}` } });
    const remove = (person: Record<string, unknown>, id: string) =>
      inject({ method: 'DELETE', url: `/api/mcp/connections/${encodeURIComponent(id)}`, headers: { authorization: `Bearer ${firebaseToken(person)}` } });
    const erin = { sub: 'uid-erin', email: 'erin@example.com' };
    const finn = { sub: 'uid-finn', email: 'finn@example.com' };

    it('lists a person’s connected tools and nobody else’s', async () => {
      await connect(erin);
      const mine = await list(erin);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().data).toHaveLength(1);
      expect(mine.json().data[0]).toMatchObject({ client_name: 'Test Client' });
      expect(typeof mine.json().data[0].last_used_at).toBe('string');

      const theirs = await list(finn);
      expect(theirs.json().data).toEqual([]);
    });

    it('disconnects from settings at once, and only the person’s own tool', async () => {
      const { tokens } = await connect({ sub: 'uid-hana', email: 'hana@example.com' });
      const id = (await list({ sub: 'uid-hana', email: 'hana@example.com' })).json().data[0].id as string;

      const stranger = await remove(finn, id);
      expect(stranger.statusCode).toBe(404);
      expect((await rpc(tokens.access_token, 'tools/list', {})).statusCode).toBe(200);

      const own = await remove({ sub: 'uid-hana', email: 'hana@example.com' }, id);
      expect(own.statusCode).toBe(200);
      expect((await rpc(tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
      expect((await list({ sub: 'uid-hana', email: 'hana@example.com' })).json().data).toEqual([]);
    });

    it('asks for a real sign-in', async () => {
      expect((await inject({ method: 'GET', url: '/api/mcp/connections' })).statusCode).toBe(401);
      const guest = await list({ sub: 'uid-guest', email: undefined, firebase: { sign_in_provider: 'anonymous' } });
      expect(guest.statusCode).toBe(403);
    });

    it('remembers connections across a restart', async () => {
      await connect({ sub: 'uid-ivo', email: 'ivo@example.com' });
      const restarted = new McpOAuthService(app.get(ConfigService));
      expect(restarted.listConnections('uid-ivo')).toHaveLength(1);
    });

    it('lists a connection made before the list existed, once it is used', async () => {
      const lee = { sub: 'uid-lee', email: 'lee@example.com' };
      const { tokens } = await connect(lee);
      const id = (await list(lee)).json().data[0].id as string;
      // As if connected before connections were recorded: the token works, the list doesn't know it.
      app.get(McpOAuthService).connections.remove(id);
      expect((await list(lee)).json().data).toEqual([]);

      expect((await rpc(tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
      const listed = (await list(lee)).json().data;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id, client_name: 'Test Client' });
    });

    it('shows a person their own usage: today vs the limit, the week, recent searches', async () => {
      const pia = { sub: 'uid-pia', email: 'pia@example.com' };
      const limiter = app.get(McpRateLimitService);
      const saved = { ...limiter.limits };
      limiter.limits = { ...saved, callsPerDay: 2000 };
      try {
        const { tokens } = await connect(pia);
        await callTool(tokens.access_token, 'search_screens', { query: 'Home  screen', platform: 'ios' });
        await callTool(tokens.access_token, 'search_screens', { query: 'pricing', platform: 'web' });
        await callTool(tokens.access_token, 'search_screens', { query: 'home screen', platform: 'ios' });

        const res = await inject({ method: 'GET', url: '/api/mcp/connections/usage', headers: { authorization: `Bearer ${firebaseToken(pia)}` } });
        expect(res.statusCode).toBe(200);
        const data = res.json().data;
        expect(data.today).toMatchObject({ used: 3, limit: 2000 });
        expect(typeof data.today.resets_at).toBe('string');
        expect(data.days).toHaveLength(7);
        expect(data.days[6].calls).toBe(3);
        // Newest first; a repeated search moves to the top instead of appearing twice.
        expect(data.recent_searches.map((s: { query: string }) => s.query)).toEqual(['home screen', 'pricing']);
        expect(data.recent_searches[0]).toMatchObject({ tool: 'search_screens', client: 'Test Client' });

        // Someone else sees none of it.
        const other = await inject({ method: 'GET', url: '/api/mcp/connections/usage', headers: { authorization: `Bearer ${firebaseToken(finn)}` } });
        expect(other.json().data.recent_searches).toEqual([]);
        expect(other.json().data.today.used).toBe(0);
      } finally {
        limiter.limits = saved;
      }
    });

    it('counts how many times each tool was used this week', async () => {
      const ola = { sub: 'uid-ola', email: 'ola@example.com' };
      const { tokens } = await connect(ola);
      expect((await list(ola)).json().data[0].calls_this_week).toBe(0);

      await callTool(tokens.access_token, 'get_taxonomy', { platform: 'ios' });
      await callTool(tokens.access_token, 'search_screens', { query: 'home', platform: 'ios' });
      expect((await list(ola)).json().data[0].calls_this_week).toBe(2);
    });

    it('disconnects every tool at once, and only the person’s own', async () => {
      const max = { sub: 'uid-max', email: 'max@example.com' };
      const first = await connect(max);
      const second = await connect(max);
      const other = await connect({ sub: 'uid-noor', email: 'noor@example.com' });
      expect((await list(max)).json().data).toHaveLength(2);

      const res = await inject({ method: 'DELETE', url: '/api/mcp/connections', headers: { authorization: `Bearer ${firebaseToken(max)}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual({ disconnected: 2 });

      expect((await list(max)).json().data).toEqual([]);
      expect((await rpc(first.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
      expect((await rpc(second.tokens.access_token, 'tools/list', {})).statusCode).toBe(401);
      expect((await rpc(other.tokens.access_token, 'tools/list', {})).statusCode).toBe(200);
    });

    it('drops a connection when the tool itself disconnects', async () => {
      const { tokens } = await connect({ sub: 'uid-jo', email: 'jo@example.com' });
      await inject({ method: 'POST', url: '/api/mcp/oauth/revoke', payload: { token: tokens.refresh_token } });
      expect((await list({ sub: 'uid-jo', email: 'jo@example.com' })).json().data).toEqual([]);
    });
  });

  describe('usage report', () => {
    const report = (person: Record<string, unknown>) =>
      inject({ method: 'GET', url: '/api/mcp/usage?days=7', headers: { authorization: `Bearer ${firebaseToken(person)}` } });

    it('is for the admin only', async () => {
      expect((await inject({ method: 'GET', url: '/api/mcp/usage' })).statusCode).toBe(401);
      expect((await report({ email: 'person@example.com' })).statusCode).toBe(403);
    });

    it('counts calls, tools, AI tools, people and searches', async () => {
      const token = (await connect({ sub: 'uid-kim', email: 'kim@example.com' })).tokens.access_token;
      await callTool(token, 'search_screens', { query: 'Pricing  Plans', platform: 'web' });
      const res = await report({ email: 'admin@example.com' });
      expect(res.statusCode).toBe(200);
      const data = res.json().data;
      expect(data.days).toHaveLength(7);
      expect(data.totals.calls).toBeGreaterThan(0);
      expect(data.totals.people).toBeGreaterThan(0);
      expect(data.totals.connections).toBeGreaterThan(0);
      expect(data.tools.map((t: { name: string }) => t.name)).toContain('search_screens');
      expect(data.clients.map((c: { name: string }) => c.name)).toContain('Test Client');
      expect(data.queries.map((q: { text: string }) => q.text)).toContain('pricing plans');
      // People are counted, never listed.
      expect(JSON.stringify(data)).not.toContain('uid-kim');
      expect(JSON.stringify(data)).not.toContain('kim@example.com');
    });
  });

});
