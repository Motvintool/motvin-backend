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
