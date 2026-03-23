const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

module.exports = async (req, res) => {
  const username = req.query.username;

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  if (req.method === 'GET') {
    try {
      const trackedKey = `user:${username}:tracked`;
      const eventsKey = `user:${username}:events`;
      const activeKey = `user:${username}:active`;

      const tracked = await redis.get(trackedKey);
      const events = await redis.lrange(eventsKey, 0, 49);
      const active = await redis.get(activeKey);

      const parsedEvents = events.map(e => typeof e === 'string' ? JSON.parse(e) : e).reverse();

      return res.json({
        username: username,
        trackedGuild: tracked || null,
        activeEvent: active ? JSON.parse(active) : null,
        events: parsedEvents || []
      });
    } catch (e) {
      console.error('Get data error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { trackedGuild, activeEvent, addEvent } = req.body;

      const trackedKey = `user:${username}:tracked`;
      const eventsKey = `user:${username}:events`;
      const activeKey = `user:${username}:active`;

      if (trackedGuild !== undefined) {
        await redis.set(trackedKey, trackedGuild);
      }

      if (addEvent) {
        await redis.lpush(eventsKey, JSON.stringify(addEvent));
        await redis.ltrim(eventsKey, 0, 99);
      }

      if (activeEvent !== undefined) {
        if (activeEvent === null) {
          await redis.del(activeKey);
        } else {
          await redis.set(activeKey, JSON.stringify(activeEvent));
        }
      }

      return res.json({ success: true });
    } catch (e) {
      console.error('Update data error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
