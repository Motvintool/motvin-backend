export default () => ({
  port: parseInt(process.env.PORT, 10) || 3000,
  host: process.env.HOST || '0.0.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Data paths
  dataRoot: process.env.DATA_ROOT || './data',

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
