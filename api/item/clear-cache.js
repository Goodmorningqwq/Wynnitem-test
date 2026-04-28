const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FULL_DB_KEY = 'wynn_full_db';
const LAST_GOOD_DB_KEY = 'wynn_full_db_last_good';
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';

module.exports = async function handler(req, res) {
  global.pageCache = new Map();
  global.metadataCache = {};
  global.quickCache = {};

  if (req.query.redis === 'true') {
    const adminToken = req.headers['x-cache-admin-token'] || req.query.token || '';
    const expectedToken = process.env.CACHE_ADMIN_TOKEN || '';
    const isProduction = process.env.NODE_ENV === 'production';
    const authorized = expectedToken && adminToken && adminToken === expectedToken;

    if (isProduction && !authorized) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden: Redis cache clear requires admin token in production'
      });
    }

    try {
      await Promise.all([
        redis.del(FULL_DB_KEY),
        redis.del(LAST_GOOD_DB_KEY),
        redis.del(DISCOVERED_PAGES_KEY)
      ]);
      return res.status(200).json({ success: true, message: 'Local and Redis snapshots cleared' });
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Local cleared, Redis failed: ' + e.message });
    }
  }

  return res.status(200).json({ success: true, message: 'Local UI Cache cleared' });
};