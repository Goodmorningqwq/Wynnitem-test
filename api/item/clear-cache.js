const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = async function handler(req, res) {
  global.pageCache = new Map();
  global.metadataCache = {};
  global.quickCache = {};

  if (req.query.redis === 'true') {
    try {
      await redis.del('wynn_full_db');
      return res.status(200).json({ success: true, message: 'Local and Redis cache cleared' });
    } catch (e) {
      return res.status(500).json({ success: false, message: 'Local cleared, Redis failed: ' + e.message });
    }
  }

  return res.status(200).json({ success: true, message: 'Local UI Cache cleared' });
};