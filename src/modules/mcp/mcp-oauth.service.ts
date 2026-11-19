import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { join } from 'path';
import { FirebaseIdTokenVerifier } from '../../common/firebase-id-token';
import { signToken, verifyToken } from '../../common/signed-token';
import { fetchClientMetadataDocument, isMetadataClientId, readClientMetadata } from './mcp-client-metadata';
import { ConnectionStore } from './mcp-connections';
import { RevocationList } from './mcp-revocations';
import { McpUsageService } from './mcp-usage.service';

/**
 * The OAuth 2.1 authorization server that guards /api/mcp.
 *
 * MCP clients (Claude, Cursor, ChatGPT, …) discover this server through the
 * .well-known metadata, register themselves (RFC 7591) or identify with a
 * Client ID Metadata Document (an https client_id; see mcp-client-metadata.ts), send the person to
 * motvin.com/mcp/connect to sign in and approve, and exchange the resulting
 * code for tokens with PKCE. Nothing here needs a database: every record the
 * server hands out and later reads back — client registrations, pending
 * authorization requests, codes, access and refresh tokens — is a signed token
 * whose payload *is* the record. Codes are made single-use in memory; what has
 * been revoked before it expired lives in a small revocation list saved to
 * disk (see RevocationList).
 *
 * Every token from one approval carries the same `grant` id — the connection.
 * Revoking any of its tokens (a disconnect) blocks the whole connection, so
 * its access token stops working on the very next request instead of running
 * out its hour.
 *
 * Who the person is comes from Firebase: the connect page signs them in with
 * the normal Motvin login and posts the ID token here, where it is verified
 * the same way the admin API verifies it.
 */

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
}

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_secret_expires_at: 0;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
  redirect_uris: string[];
  token_endpoint_auth_method: 'none';
  grant_types: string[];
  response_types: string[];
  scope: string;
}

export interface AuthorizeQuery {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

export interface TokenRequest {
  grant_type?: string;
  code?: string;
  code_verifier?: string;
  client_id?: string;
  redirect_uri?: string;
  refresh_token?: string;
  resource?: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Who is calling a tool, as read from a verified access token. */
export interface McpIdentity {
  uid: string;
  /** The connection (grant) the token belongs to; null for tokens from before connection ids. */
  connectionId: string | null;
  email: string;
  name: string | null;
  clientId: string;
  clientName: string | null;
  scopes: string[];
}

/** A connected AI tool, as the person's settings page lists it. */
export interface ConnectionSummary {
  id: string;
  client_name: string;
  connected_at: string;
  last_used_at: string;
  /** Tool calls in the last 7 days. */
  calls_this_week: number;
}

/** The one scope this server grants. Requests for others (openid, …) get this. */
export const MCP_SCOPE = 'inspirations:read';

type ClientRecord = { typ: 'client'; name: string | null; uri: string | null; logo: string | null; redirect_uris: string[] };
type PendingRecord = {
  typ: 'authreq';
  client_id: string;
  client_name: string | null;
  redirect_uri: string;
  code_challenge: string;
  state: string | null;
  scope: string;
};
type CodeRecord = Omit<PendingRecord, 'typ'> & { typ: 'code'; jti: string; sub: string; email: string; name: string | null };
/** `grant` is the connection id; tokens issued before it existed may lack one. */
type AccessRecord = { typ: 'access'; jti: string; grant?: string; iss: string; aud: string; sub: string; email: string; name: string | null; client_id: string; client_name: string | null; scope: string };
type RefreshRecord = { typ: 'refresh'; jti: string; grant?: string; sub: string; email: string; name: string | null; client_id: string; client_name: string | null; scope: string };

const TTL = {
  /** A registration never really expires; ten years reads as "never" without a special case. */
  client: 10 * 365 * 24 * 3600,
  /** How long the person has to sign in and approve after their tool sent them over. */
  request: 10 * 60,
  code: 5 * 60,
  access: 60 * 60,
  refresh: 30 * 24 * 3600,
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** How long a fetched client metadata document is trusted before it is fetched again. */
const METADATA_CACHE_MS = 5 * 60 * 1000;
const METADATA_CACHE_MAX = 500;

@Injectable()
export class McpOAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(McpOAuthService.name);

  /** Public origin of this API; also the OAuth issuer identifier. */
  readonly issuer: string;
  /** The protected resource: the MCP endpoint itself. */
  readonly resource: string;
  readonly connectUrl: string;
  readonly siteUrl: string;

  private readonly secret: string;
  private readonly configured: boolean;
  private readonly verifier: FirebaseIdTokenVerifier;

  /** Authorization codes already exchanged (jti → expiry), so a code works once. */
  private readonly usedCodes = new Map<string, number>();
  /**
   * Revoked before they expired, saved across restarts: `grant:<id>` blocks a
   * whole connection, `jti:<id>` a single refresh or access token.
   */
  private readonly revoked: RevocationList;
  /** Each person's connected tools, for their settings page (see ConnectionStore). */
  readonly connections: ConnectionStore;
  /** Client metadata documents already fetched (client_id → client), briefly. */
  private readonly metadataClients = new Map<string, { client: RegisteredClient; expiresAt: number }>();
  /** Fetches a client's metadata document; tests replace it. */
  fetchClientMetadata: (clientId: string) => Promise<unknown> = fetchClientMetadataDocument;

  constructor(
    config: ConfigService,
    @Optional() private readonly usage?: McpUsageService,
  ) {
    this.issuer = config.get<string>('mcp.issuer');
    this.resource = `${this.issuer}/api/mcp`;
    this.connectUrl = config.get<string>('mcp.connectUrl');
    this.siteUrl = config.get<string>('mcp.siteUrl');
    this.verifier = new FirebaseIdTokenVerifier(config.get<string>('firebase.projectId') || '');
    const revocationFile =
      config.get<string>('mcp.revocationFile') || join(config.get<string>('dataRoot') || './data', '.mcp-revocations.json');
    this.revoked = new RevocationList(revocationFile);
    const connectionsFile =
      config.get<string>('mcp.connectionsFile') || join(config.get<string>('dataRoot') || './data', '.mcp-connections.json');
    this.connections = new ConnectionStore(connectionsFile);

    const secret = config.get<string>('mcp.secret') || '';
    if (secret) {
      this.secret = secret;
      this.configured = true;
    } else if (config.get<string>('nodeEnv') === 'production') {
      // Fail closed: the rest of the API keeps running, MCP answers 503.
      this.secret = '';
      this.configured = false;
      this.logger.error('MCP_TOKEN_SECRET is not set — refusing every MCP request');
    } else {
      this.secret = randomBytes(32).toString('hex');
      this.configured = true;
      this.logger.warn('MCP_TOKEN_SECRET is not set — using a throwaway secret; MCP tokens will not survive a restart');
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  /** Last-used times are saved lazily; write them out before the process ends. */
  onModuleDestroy(): void {
    this.connections.flush();
  }

  // ---------------------------------------------------------------- metadata

  authorizationServerMetadata() {
    const base = `${this.issuer}/api/mcp/oauth`;
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      scopes_supported: [MCP_SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      service_documentation: `${this.siteUrl}/mcp`,
    };
  }

  protectedResourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.issuer],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Motvin Inspirations',
      resource_documentation: `${this.siteUrl}/mcp`,
    };
  }

  // ------------------------------------------------------------ registration

  /**
   * Dynamic client registration. The client is a public client (PKCE, no
   * secret); its id is a signed copy of what it registered, so no store is
   * needed to recognise it later.
   */
  registerClient(body: unknown): RegisteredClient {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const uris = Array.isArray(input.redirect_uris) ? input.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if (!uris.length) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must list at least one URL');
    for (const uri of uris) {
      if (!this.isAcceptableRedirectUri(uri)) throw new OAuthError('invalid_redirect_uri', `redirect_uri is not acceptable: ${uri}`);
    }
    const grants = Array.isArray(input.grant_types) ? input.grant_types : ['authorization_code'];
    if (!grants.includes('authorization_code')) {
      throw new OAuthError('invalid_client_metadata', 'Only the authorization_code grant is supported');
    }

    const record: ClientRecord = {
      typ: 'client',
      name: typeof input.client_name === 'string' ? input.client_name.slice(0, 120) : null,
      uri: typeof input.client_uri === 'string' ? input.client_uri.slice(0, 500) : null,
      logo: typeof input.logo_uri === 'string' ? input.logo_uri.slice(0, 500) : null,
      redirect_uris: uris,
    };
    const client_id = signToken(record, this.secret, TTL.client);
    return this.describeClient(client_id, record);
  }

  /**
   * The client behind a client_id: a metadata document URL is fetched (and
   * kept for a few minutes); anything else is a registration this server signed.
   * A document that can't be fetched or doesn't check out is an invalid_client.
   */
  async resolveClient(clientId: string): Promise<RegisteredClient | null> {
    if (!isMetadataClientId(clientId)) return this.getClient(clientId);
    const cached = this.metadataClients.get(clientId);
    if (cached && cached.expiresAt > Date.now()) return cached.client;

    let document: unknown;
    try {
      document = await this.fetchClientMetadata(clientId);
    } catch (error) {
      this.logger.warn(`Client metadata ${clientId} could not be read: ${(error as Error).message}`);
      throw new OAuthError('invalid_client', 'The client_id metadata document could not be read');
    }
    const metadata = readClientMetadata(clientId, document, (uri) => this.isAcceptableRedirectUri(uri));
    if ('error' in metadata) throw new OAuthError('invalid_client', metadata.error);

    const client: RegisteredClient = {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_secret_expires_at: 0,
      ...(metadata.client_name ? { client_name: metadata.client_name } : {}),
      ...(metadata.client_uri ? { client_uri: metadata.client_uri } : {}),
      ...(metadata.logo_uri ? { logo_uri: metadata.logo_uri } : {}),
      redirect_uris: metadata.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_SCOPE,
    };
    if (this.metadataClients.size >= METADATA_CACHE_MAX) this.metadataClients.clear();
    this.metadataClients.set(clientId, { client, expiresAt: Date.now() + METADATA_CACHE_MS });
    return client;
  }

  getClient(clientId: string): RegisteredClient | null {
    const record = verifyToken<ClientRecord>(clientId, this.secret);
    if (!record || record.typ !== 'client') return null;
    return this.describeClient(clientId, record);
  }

  private describeClient(client_id: string, record: ClientRecord): RegisteredClient {
    const issuedAt = verifyToken<ClientRecord>(client_id, this.secret)?.iat ?? Math.floor(Date.now() / 1000);
    return {
      client_id,
      client_id_issued_at: issuedAt,
      client_secret_expires_at: 0,
      ...(record.name ? { client_name: record.name } : {}),
      ...(record.uri ? { client_uri: record.uri } : {}),
      ...(record.logo ? { logo_uri: record.logo } : {}),
      redirect_uris: record.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MCP_SCOPE,
    };
  }

  /**
   * https anywhere, http only on loopback (a CLI catching the redirect on a
   * local port), and custom schemes for desktop apps (cursor://, vscode://).
   */
  private isAcceptableRedirectUri(uri: string): boolean {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return false;
    }
    const scheme = url.protocol.replace(/:$/, '').toLowerCase();
    if (['javascript', 'data', 'file', 'blob'].includes(scheme)) return false;
    if (scheme === 'http') return LOOPBACK_HOSTS.has(url.hostname) || url.hostname === '::1';
    return true;
  }

  /**
   * Whether a requested redirect_uri matches one the client registered. Exact
   * match, except that an http loopback address may use any port: native apps
   * pick a free port at sign-in time (RFC 8252 §7.3) — Codex registers
   * http://127.0.0.1/callback/… and then asks for http://127.0.0.1:62955/callback/….
   */
  private isRegisteredRedirectUri(registered: string[], requested: string): boolean {
    if (registered.includes(requested)) return true;
    let asked: URL;
    try {
      asked = new URL(requested);
    } catch {
      return false;
    }
    if (asked.protocol !== 'http:' || !this.isAcceptableRedirectUri(requested)) return false;
    return registered.some((uri) => {
      try {
        const known = new URL(uri);
        return known.protocol === 'http:' && known.hostname === asked.hostname && known.pathname === asked.pathname && known.search === asked.search;
      } catch {
        return false;
      }
    });
  }

  // ----------------------------------------------------------- authorization

  /**
   * Step one of the flow. Checks the request and sends the person to the
   * connect page, carrying the request as a signed token. Returns where to
   * redirect; throws OAuthError only for failures that must not be redirected
   * to the client (unknown client, bad redirect_uri) — everything after that
   * goes back to the client's redirect_uri as an OAuth error, per spec.
   */
  async beginAuthorization(query: AuthorizeQuery): Promise<{ redirectTo: string }> {
    const client = query.client_id ? await this.resolveClient(query.client_id) : null;
    if (!client) throw new OAuthError('invalid_client', 'Unknown client_id — register first', 400);

    let redirectUri = query.redirect_uri;
    if (!redirectUri) {
      if (client.redirect_uris.length !== 1) throw new OAuthError('invalid_request', 'redirect_uri is required');
      redirectUri = client.redirect_uris[0];
    } else if (!this.isRegisteredRedirectUri(client.redirect_uris, redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri was not registered by this client');
    }

    const fail = (error: string, description: string) => ({
      redirectTo: this.withParams(redirectUri, { error, error_description: description, state: query.state }),
    });

    if (query.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported');
    if (!query.code_challenge) return fail('invalid_request', 'code_challenge is required (PKCE)');
    if (query.code_challenge_method !== 'S256') return fail('invalid_request', 'code_challenge_method must be S256');
    if (query.resource && query.resource.replace(/\/+$/, '') !== this.resource) {
      return fail('invalid_target', `This authorization server only issues tokens for ${this.resource}`);
    }

    const pending: PendingRecord = {
      typ: 'authreq',
      client_id: client.client_id,
      client_name: client.client_name ?? null,
      redirect_uri: redirectUri,
      code_challenge: query.code_challenge,
      state: query.state ?? null,
      scope: MCP_SCOPE,
    };
    const request = signToken(pending, this.secret, TTL.request);
    return { redirectTo: this.withParams(this.connectUrl, { request }) };
  }

  /** What the connect page shows before the person decides. */
  describeRequest(request: string) {
    const pending = this.pending(request);
    let destination = pending.redirect_uri;
    try {
      const url = new URL(pending.redirect_uri);
      destination = url.protocol === 'https:' || url.protocol === 'http:' ? url.host : `${url.protocol}//`;
    } catch {
      // Leave the raw value; it was accepted at registration.
    }
    return {
      client_name: pending.client_name || 'An AI tool',
      destination,
      scope: pending.scope,
      permissions: ['Search and read screens, flows, apps and patterns in the Motvin library'],
    };
  }

  /**
   * The person signed in and clicked Allow. The ID token proves who they are;
   * the code the client receives carries that identity, signed.
   */
  async approve(request: string, idToken: string): Promise<{ redirectTo: string }> {
    const pending = this.pending(request);
    if (typeof idToken !== 'string' || !idToken) throw new OAuthError('invalid_request', 'Sign in first', 401);

    const claims = await this.verifier.verify(idToken);
    if (claims.firebase?.sign_in_provider === 'anonymous') {
      throw new OAuthError('access_denied', 'Guest sessions cannot connect an AI tool — sign in with a Motvin account', 403);
    }
    const email = (claims.email || '').toLowerCase();
    if (!email) throw new OAuthError('access_denied', 'This account has no email address', 403);

    const code: CodeRecord = {
      ...pending,
      typ: 'code',
      jti: randomBytes(16).toString('hex'),
      sub: claims.sub,
      email,
      name: claims.name || null,
    };
    this.logger.log(`${email} approved ${pending.client_name || 'a client'}`);
    return {
      redirectTo: this.withParams(pending.redirect_uri, {
        code: signToken(code, this.secret, TTL.code),
        state: pending.state ?? undefined,
      }),
    };
  }

  /** The person clicked Don't allow. */
  deny(request: string): { redirectTo: string } {
    const pending = this.pending(request);
    return {
      redirectTo: this.withParams(pending.redirect_uri, {
        error: 'access_denied',
        error_description: 'The person declined the connection',
        state: pending.state ?? undefined,
      }),
    };
  }

  private pending(request: string): PendingRecord {
    const pending = typeof request === 'string' ? verifyToken<PendingRecord>(request, this.secret) : null;
    if (!pending || pending.typ !== 'authreq') {
      throw new OAuthError('invalid_request', 'This connection request has expired — start again from your AI tool', 400);
    }
    return pending;
  }

  // ------------------------------------------------------------------ tokens

  token(body: TokenRequest): TokenResponse {
    this.prune();
    switch (body.grant_type) {
      case 'authorization_code':
        return this.exchangeCode(body);
      case 'refresh_token':
        return this.refresh(body);
      default:
        throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  }

  private exchangeCode(body: TokenRequest): TokenResponse {
    if (!body.client_id) throw new OAuthError('invalid_client', 'client_id is required', 401);
    const code = body.code ? verifyToken<CodeRecord>(body.code, this.secret) : null;
    if (!code || code.typ !== 'code') throw new OAuthError('invalid_grant', 'Authorization code is invalid or expired');
    if (code.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
    if (body.redirect_uri && body.redirect_uri !== code.redirect_uri) {
      throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    }
    if (!body.code_verifier) throw new OAuthError('invalid_grant', 'code_verifier is required (PKCE)');
    const challenge = createHash('sha256').update(body.code_verifier).digest('base64url');
    if (challenge !== code.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match code_challenge');
    if (body.resource && body.resource.replace(/\/+$/, '') !== this.resource) {
      throw new OAuthError('invalid_target', `Tokens are only issued for ${this.resource}`);
    }
    if (this.usedCodes.has(code.jti)) throw new OAuthError('invalid_grant', 'Authorization code was already used');
    this.usedCodes.set(code.jti, code.exp);

    // A new connection: every token it ever gets shares this id.
    const grant = randomBytes(12).toString('hex');
    this.connections.upsert({ id: grant, uid: code.sub, email: code.email, clientName: code.client_name, expiresAt: this.refreshExpiry() });
    this.usage?.recordConnection();
    return this.issue(grant, code.sub, code.email, code.name, code.client_id, code.client_name, code.scope);
  }

  private refresh(body: TokenRequest): TokenResponse {
    if (!body.client_id) throw new OAuthError('invalid_client', 'client_id is required', 401);
    const token = body.refresh_token ? verifyToken<RefreshRecord>(body.refresh_token, this.secret) : null;
    if (!token || token.typ !== 'refresh') throw new OAuthError('invalid_grant', 'Refresh token is invalid or expired');
    if (token.client_id !== body.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    if (this.revoked.has(`jti:${token.jti}`)) throw new OAuthError('invalid_grant', 'Refresh token was revoked');
    if (token.grant && this.revoked.has(`grant:${token.grant}`)) throw new OAuthError('invalid_grant', 'This connection was disconnected');
    // Rotation: the old refresh token dies with its use.
    this.revoked.add(`jti:${token.jti}`, token.exp);

    // Same connection; a token from before connection ids starts one now.
    const grant = token.grant || randomBytes(12).toString('hex');
    this.connections.upsert({ id: grant, uid: token.sub, email: token.email, clientName: token.client_name, expiresAt: this.refreshExpiry() });
    return this.issue(grant, token.sub, token.email, token.name, token.client_id, token.client_name, token.scope);
  }

  /** When a refresh token issued now runs out: how long a connection lasts unused. */
  private refreshExpiry(): number {
    return Math.floor(Date.now() / 1000) + TTL.refresh;
  }

  private issue(grant: string, sub: string, email: string, name: string | null, client_id: string, client_name: string | null, scope: string): TokenResponse {
    const access: AccessRecord = { typ: 'access', jti: randomBytes(8).toString('hex'), grant, iss: this.issuer, aud: this.resource, sub, email, name, client_id, client_name, scope };
    const refresh: RefreshRecord = { typ: 'refresh', jti: randomBytes(16).toString('hex'), grant, sub, email, name, client_id, client_name, scope };
    return {
      access_token: signToken(access, this.secret, TTL.access),
      token_type: 'Bearer',
      expires_in: TTL.access,
      refresh_token: signToken(refresh, this.secret, TTL.refresh),
      scope,
    };
  }

  /**
   * RFC 7009, applied to the whole connection: revoking either token of a
   * connection blocks every token it was given, so the access token stops
   * working on the next request instead of running out its hour. The block is
   * kept for the longest a token of that connection could still live.
   */
  revoke(token: string): void {
    const record = typeof token === 'string' ? verifyToken<AccessRecord | RefreshRecord>(token, this.secret) : null;
    if (!record || (record.typ !== 'refresh' && record.typ !== 'access')) return;
    this.revoked.add(`jti:${record.jti}`, record.exp);
    if (record.grant) {
      this.revoked.add(`grant:${record.grant}`, this.refreshExpiry());
      this.connections.remove(record.grant);
    }
    this.logger.log(`${record.email} disconnected ${record.client_name || 'a client'}`);
  }

  // ------------------------------------------------- the person's own view

  /**
   * Who is asking, from a Firebase ID token — for the settings page's list of
   * connected tools. Guest sessions have no connections and are refused.
   */
  async identifyPerson(idToken: string): Promise<{ uid: string; email: string }> {
    if (!idToken) throw new OAuthError('unauthorized', 'Sign in first', 401);
    let claims: Awaited<ReturnType<FirebaseIdTokenVerifier['verify']>>;
    try {
      claims = await this.verifier.verify(idToken);
    } catch {
      throw new OAuthError('unauthorized', 'Your sign-in could not be verified — sign in again', 401);
    }
    if (claims.firebase?.sign_in_provider === 'anonymous') throw new OAuthError('forbidden', 'Sign in with a Motvin account', 403);
    return { uid: claims.sub, email: (claims.email || '').toLowerCase() };
  }

  /** The person's connected AI tools, most recently used first. */
  listConnections(uid: string): ConnectionSummary[] {
    return this.connections.listFor(uid).map((entry) => ({
      id: entry.id,
      client_name: entry.clientName || 'An AI tool',
      connected_at: new Date(entry.connectedAt).toISOString(),
      last_used_at: new Date(entry.lastUsedAt).toISOString(),
      calls_this_week: this.connections.callsThisWeek(entry.id),
    }));
  }

  /**
   * Disconnects one of the person's own tools from the settings page: the
   * same as the tool revoking its token — every key of that connection stops
   * working on the next request. False when it is not theirs or already gone.
   */
  disconnect(uid: string, id: string): boolean {
    const entry = typeof id === 'string' ? this.connections.get(id) : undefined;
    if (!entry || entry.uid !== uid) return false;
    this.revoked.add(`grant:${id}`, this.refreshExpiry());
    this.connections.remove(id);
    this.logger.log(`${entry.email} disconnected ${entry.clientName || 'a client'} from settings`);
    return true;
  }

  /** Disconnects every tool the person has connected (a lost laptop). Returns how many. */
  disconnectAll(uid: string): number {
    const mine = this.connections.listFor(uid);
    for (const entry of mine) {
      this.revoked.add(`grant:${entry.id}`, this.refreshExpiry());
      this.connections.remove(entry.id);
    }
    if (mine.length) this.logger.log(`${mine[0].email} disconnected all ${mine.length} tool(s) from settings`);
    return mine.length;
  }

  verifyAccessToken(token: string): McpIdentity | null {
    const record = verifyToken<AccessRecord>(token, this.secret);
    if (!record || record.typ !== 'access') return null;
    if (record.iss !== this.issuer || record.aud !== this.resource) return null;
    if (this.revoked.has(`jti:${record.jti}`)) return null;
    if (record.grant && this.revoked.has(`grant:${record.grant}`)) return null;
    if (record.grant) {
      // Listed for the person's settings page. A connection made before the
      // list existed (or lost from it) is added the first time it is used.
      if (this.connections.get(record.grant)) this.connections.touch(record.grant);
      else this.connections.upsert({ id: record.grant, uid: record.sub, email: record.email, clientName: record.client_name, expiresAt: this.refreshExpiry() });
    }
    return {
      uid: record.sub,
      connectionId: record.grant ?? null,
      email: record.email,
      name: record.name ?? null,
      clientId: record.client_id,
      clientName: record.client_name ?? null,
      scopes: record.scope.split(' ').filter(Boolean),
    };
  }

  // ----------------------------------------------------------------- helpers

  private prune() {
    const now = Math.floor(Date.now() / 1000);
    for (const [jti, exp] of this.usedCodes) if (exp <= now) this.usedCodes.delete(jti);
  }

  private withParams(base: string, params: Record<string, string | undefined>): string {
    const url = new URL(base);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, value);
    return url.toString();
  }
}
