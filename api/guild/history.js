const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

const HISTORY_KEY = 'guild_events';

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      const events = await redis.lrange(HISTORY_KEY, 0, 49);
      const parsed = events.map(e => typeof e === 'string' ? JSON.parse(e) : e);
      return res.json(parsed.reverse());
    } catch (e) {
      console.error('Redis get error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const event = req.body;
      await redis.lpush(HISTORY_KEY, JSON.stringify(event));
      await redis.ltrim(HISTORY_KEY, 0, 99);
      return res.json({ success: true });
    } catch (e) {
      console.error('Redis push error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
