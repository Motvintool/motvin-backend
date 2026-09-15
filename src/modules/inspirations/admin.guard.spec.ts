import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, createSign } from 'crypto';
import { AdminGuard } from './admin.guard';

/**
 * Covers the part of the guard that decides who may write to the library.
 *
 * Google's real signing keys cannot be used in a test, so the cert cache is
 * primed with a key pair generated here. Everything else runs for real: the
 * RS256 signature check, the claim checks, and the email allowlist.
 */

const PROJECT_ID = 'motvin-prod';
const ADMIN_EMAIL = 'surendarv638@gmail.com';
const KID = 'test-kid';

// A self-signed certificate the guard can verify tokens against.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

/**
 * Node cannot mint an X.509 certificate, and the guard reads certs with
 * createPublicKey, which also accepts a bare public key PEM. The cache is
 * primed with that instead.
 */
const CERT_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function makeToken(claims: Record<string, unknown>, options: { kid?: string; alg?: string; sign?: boolean } = {}) {
  const header = { alg: options.alg ?? 'RS256', kid: options.kid ?? KID };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode(header)}.${encode(claims)}`;
  if (options.sign === false) return `${body}.`;
  const signature = createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url');
  return `${body}.${signature}`;
}

function validClaims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: 'uid-123',
    iat: now - 10,
    exp: now + 3600,
    email: ADMIN_EMAIL,
    email_verified: true,
    ...overrides,
  };
}

function makeGuard(emails: string[] = [ADMIN_EMAIL]) {
  const config = {
    get: (key: string) => {
      if (key === 'firebase.projectId') return PROJECT_ID;
      if (key === 'admin.emails') return emails;
      return undefined;
    },
  } as unknown as ConfigService;

  const guard = new AdminGuard(config);
  // Prime the cert cache so no network call happens during the test.
  (guard as unknown as { certs: Record<string, string>; certsExpireAt: number }).certs = { [KID]: CERT_PEM };
  (guard as unknown as { certsExpireAt: number }).certsExpireAt = Date.now() + 60_000;
  return guard;
}

function contextFor(token?: string) {
  const request: Record<string, unknown> = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    request,
  } as never as Parameters<AdminGuard['canActivate']>[0] & { request: Record<string, unknown> };
}

describe('AdminGuard', () => {
  it('admits the allowed account and records its identity', async () => {
    const guard = makeGuard();
    const context = contextFor(makeToken(validClaims()));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect((context as unknown as { request: { admin?: { email: string } } }).request.admin).toEqual({
      uid: 'uid-123',
      email: ADMIN_EMAIL,
    });
  });

  it('refuses a correctly signed token for a different account', async () => {
    const guard = makeGuard();
    const token = makeToken(validClaims({ email: 'someone.else@gmail.com' }));

    await expect(guard.canActivate(contextFor(token))).rejects.toThrow(
      /may not administer/i,
    );
  });

  it('refuses an account whose email is not verified', async () => {
    const guard = makeGuard();
    const token = makeToken(validClaims({ email_verified: false }));

    await expect(guard.canActivate(contextFor(token))).rejects.toThrow(/not verified/i);
  });

  it('matches the allowlist regardless of case', async () => {
    const guard = makeGuard();
    const token = makeToken(validClaims({ email: ADMIN_EMAIL.toUpperCase() }));

    await expect(guard.canActivate(contextFor(token))).resolves.toBe(true);
  });

  it('refuses a token signed by anyone else', async () => {
    const guard = makeGuard();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: KID })).toString('base64url');
    const body = Buffer.from(JSON.stringify(validClaims())).toString('base64url');
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${body}`)
      .sign(other.privateKey)
      .toString('base64url');

    await expect(guard.canActivate(contextFor(`${header}.${body}.${signature}`))).rejects.toThrow(
      /signature is invalid/i,
    );
  });

  it('refuses an unsigned token', async () => {
    const guard = makeGuard();
    const token = makeToken(validClaims(), { alg: 'none', sign: false });

    await expect(guard.canActivate(contextFor(token))).rejects.toThrow(/algorithm/i);
  });

  it('refuses an expired token', async () => {
    const guard = makeGuard();
    const now = Math.floor(Date.now() / 1000);
    const token = makeToken(validClaims({ iat: now - 7200, exp: now - 3600 }));

    await expect(guard.canActivate(contextFor(token))).rejects.toThrow(/expired/i);
  });

  it('refuses a token minted for another Firebase project', async () => {
    const guard = makeGuard();
    const token = makeToken(validClaims({ aud: 'someone-elses-project' }));

    await expect(guard.canActivate(contextFor(token))).rejects.toThrow(/another project/i);
  });

  it('refuses every request when no admin email is configured', async () => {
    const guard = makeGuard([]);

    await expect(guard.canActivate(contextFor(makeToken(validClaims())))).rejects.toThrow(
      /not configured/i,
    );
  });

  it('refuses a request with no token', async () => {
    const guard = makeGuard();

    await expect(guard.canActivate(contextFor())).rejects.toThrow(/missing bearer token/i);
  });
});
