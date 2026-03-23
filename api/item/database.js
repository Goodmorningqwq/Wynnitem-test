const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds

module.exports = async function handler(req, res) {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `wynn_page_${page}`;
  
  console.log(`[Vercel/database] Page: ${page}`);

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      res.setHeader('X-Cache', 'HIT');
      console.log(`[Vercel/database] Cache HIT for page ${page}`);
      return res.status(200).json(cachedData);
    }
  } catch (e) {
    console.error(`[Vercel/database] Redis GET error: ${e.message}`);
  }
  
  console.log(`[Vercel/database] Cache MISS, fetching page ${page} from Wynncraft API`);

  const url = `${WYNCRAFT_BASE}?page=${page}`;

  try {
    const upstreamRes = await fetch(url);
    const rawText = await upstreamRes.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }

    console.log(`[Vercel/database] Upstream status: ${upstreamRes.status}`);

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    try {
      await redis.setex(cacheKey, TTL, data);
      console.log(`[Vercel/database] Cached page ${page} with TTL ${TTL}s`);
    } catch (e) {
      console.error(`[Vercel/database] Redis SET error: ${e.message}`);
    }
    
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[Vercel/database] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
