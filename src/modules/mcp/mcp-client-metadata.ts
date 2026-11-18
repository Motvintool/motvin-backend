import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Client ID Metadata Documents (CIMD), the MCP spec's newer way for a client
 * to identify itself: instead of registering first, its client_id *is* an
 * https URL, and that URL serves a small JSON document saying who the client
 * is and where it may be redirected. The authorization server fetches the
 * document when the client shows up.
 *
 * Fetching a URL a stranger chose is the risky part, so the fetch is fenced:
 * https only, no credentials or fragment in the URL, hosts that resolve to
 * private or loopback addresses refused (so a client_id can't make the server
 * call into its own network), no redirects, a short timeout and a small size
 * cap.
 */

/** What the server keeps from a client's metadata document. */
export interface ClientMetadata {
  client_id: string;
  client_name: string | null;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: string[];
}

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 64 * 1024;

/** Whether a client_id is a metadata document URL rather than a registered (signed) id. */
export function isMetadataClientId(clientId: string): boolean {
  if (!clientId.startsWith('https://')) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname !== '/' && !url.hash && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Loopback, private, link-local, carrier-grade NAT and other non-public addresses. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(ip) === 6) return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
  return true;
}

/**
 * Fetches and parses a client's metadata document. Throws a short, readable
 * message when the URL is refused or the document can't be read.
 */
export async function fetchClientMetadataDocument(clientId: string): Promise<unknown> {
  if (!isMetadataClientId(clientId)) throw new Error('client_id is not an https URL with a path');
  const host = new URL(clientId).hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((entry) => entry.address);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('client_id points to a private address');

  const response = await fetch(clientId, {
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`client metadata answered ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) throw new Error('client metadata is too large');
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new Error('client metadata is too large');
  return JSON.parse(text);
}

/**
 * Checks a fetched document against the client_id it came from. Returns the
 * client, or a reason it was refused. `acceptRedirect` is the server's own
 * rule for redirect URIs, the same one dynamic registration uses.
 */
export function readClientMetadata(
  clientId: string,
  document: unknown,
  acceptRedirect: (uri: string) => boolean,
): ClientMetadata | { error: string } {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return { error: 'client metadata is not a JSON object' };
  const doc = document as Record<string, unknown>;
  if (doc.client_id !== clientId) return { error: 'client metadata client_id does not match its URL' };
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
  if (!uris.length) return { error: 'client metadata lists no redirect_uris' };
  const bad = uris.find((uri) => !acceptRedirect(uri));
  if (bad) return { error: `client metadata redirect_uri is not acceptable: ${bad}` };
  // This server only has public clients (PKCE, no secret), so the client must be able to
  // use "none" — as its chosen method, or among the ones it lists as supported (ChatGPT
  // prefers private_key_jwt but lists "none" too, and uses it with servers that only offer it).
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [];
  if (doc.token_endpoint_auth_method !== undefined && doc.token_endpoint_auth_method !== 'none' && !supported.includes('none')) {
    return { error: 'client metadata must allow token_endpoint_auth_method "none"' };
  }
  if (Array.isArray(doc.grant_types) && !doc.grant_types.includes('authorization_code')) {
    return { error: 'client metadata must allow the authorization_code grant' };
  }
  const text = (value: unknown, max: number) => (typeof value === 'string' && value ? value.slice(0, max) : null);
  return {
    client_id: clientId,
    client_name: text(doc.client_name, 120),
    client_uri: text(doc.client_uri, 500),
    logo_uri: text(doc.logo_uri, 500),
    redirect_uris: uris,
  };
}
