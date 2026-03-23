const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  
  const query = req.query.query || '';
  const cacheKey = `wynn_quick_${query}`;
  
  console.log(`[Vercel/quick] Query: "${query}"`);
  
  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      console.log(`[Vercel/quick] Cache HIT for query "${query}"`);
      return res.status(200).json(cachedData);
    }
  } catch (e) {
    console.error(`[Vercel/quick] Redis GET error: ${e.message}`);
  }

  console.log(`[Vercel/quick] Cache MISS, fetching query "${query}" from Wynncraft API`);

  const url = `https://api.wynncraft.com/v3/item/search/${encodeURIComponent(query)}`;

  try {
    const upstreamRes = await fetch(url);
    const data = await upstreamRes.json();

    console.log(`[Vercel/quick] Upstream status: ${upstreamRes.status}`);

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    try {
      await redis.setex(cacheKey, TTL, data);
      console.log(`[Vercel/quick] Cached query "${query}" with TTL ${TTL}s`);
    } catch (e) {
      console.error(`[Vercel/quick] Redis SET error: ${e.message}`);
    }

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[Vercel/quick] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
