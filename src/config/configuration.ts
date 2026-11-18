// Where MCP's public URLs point when the MCP_* variables are not set: the
// deployed hosts in production, the two local dev servers otherwise.
const isProduction = process.env.NODE_ENV === 'production';
const localApi = `http://localhost:${process.env.PORT || 3000}`;
const localWeb = 'http://localhost:3001';

const intOrUndefined = (value: string | undefined) => (value === undefined || value === '' ? undefined : Number(value));

export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Data paths
  dataRoot: process.env.DATA_ROOT || './data',

  // Firebase project whose ID tokens the admin API accepts. Must match the
  // NEXT_PUBLIC_FIREBASE_PROJECT_ID the web app signs in against.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || 'motvin-prod',
  },

  // Who may write to the Inspirations store. Comma-separated, lower-cased.
  // An empty list disables the admin API entirely rather than opening it up.
  admin: {
    emails: (process.env.INSPIRATIONS_ADMIN_EMAILS || 'surendarv638@gmail.com')
      .split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  },

  // MCP server (api.motvin.com/api/mcp) and the OAuth server that guards it.
  mcp: {
    // Signs access tokens, refresh tokens, authorization codes and client
    // registrations. Empty disables MCP entirely in production; in development
    // a throwaway secret is generated at boot.
    secret: process.env.MCP_TOKEN_SECRET || '',
    // Public origin of this API, as clients reach it. Also the OAuth issuer.
    issuer: (process.env.MCP_ISSUER_URL || (isProduction ? 'https://api.motvin.com' : localApi)).replace(/\/+$/, ''),
    // The web page where a person signs in and approves a connecting client.
    connectUrl: process.env.MCP_CONNECT_URL || (isProduction ? 'https://motvin.com/mcp/connect' : `${localWeb}/mcp/connect`),
    // Public site, for the page links that tool results carry.
    siteUrl: (process.env.MCP_SITE_URL || (isProduction ? 'https://motvin.com' : localWeb)).replace(/\/+$/, ''),
    // Where disconnected tools are remembered across restarts. Empty means
    // <DATA_ROOT>/.mcp-revocations.json. Must be on a disk that survives deploys.
    revocationFile: process.env.MCP_REVOCATION_FILE || '',
    // Each person's connected tools, and daily usage counts. Empty = under DATA_ROOT.
    connectionsFile: process.env.MCP_CONNECTIONS_FILE || '',
    usageFile: process.env.MCP_USAGE_FILE || '',
    // Each person's call count for the day, so a restart doesn't reset it. Empty = under DATA_ROOT.
    rateLimitFile: process.env.MCP_RATE_LIMIT_FILE || '',
    // Rate limits (0 turns one off). Unset or invalid values use the defaults
    // in mcp-rate-limit.service.ts: 60 tool calls a minute and 2000 a day per
    // person, 60 screen previews a minute per person, 30 OAuth requests a
    // minute per client address.
    rateLimits: {
      callsPerMinute: intOrUndefined(process.env.MCP_RATE_CALLS_PER_MINUTE),
      callsPerDay: intOrUndefined(process.env.MCP_RATE_CALLS_PER_DAY),
      previewsPerMinute: intOrUndefined(process.env.MCP_RATE_PREVIEWS_PER_MINUTE),
      oauthPerMinute: intOrUndefined(process.env.MCP_RATE_OAUTH_PER_MINUTE),
    },
  },

  // Cache configuration
  cache: {
    maxCollections: parseInt(process.env.CACHE_MAX_COLLECTIONS, 10) || 50,
    maxSizeMB: parseInt(process.env.CACHE_MAX_SIZE_MB, 10) || 500,
    collectionTTL: parseInt(process.env.CACHE_COLLECTION_TTL_HOURS, 10) * 60 * 60 * 1000 || 3600000,
    iconTTL: parseInt(process.env.CACHE_ICON_TTL_MINUTES, 10) * 60 * 1000 || 1800000,
  },

  // Logging
  log: {
    level: process.env.LOG_LEVEL || 'info',
    pretty: process.env.LOG_PRETTY === 'true',
  },
});
