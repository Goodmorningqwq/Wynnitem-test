const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `wynn_page_${page}`;
  
  const startTime = Date.now();
  console.log(`[Vercel/Redis] Page: ${page}`);

  try {
    const redisStart = Date.now();
    const cachedData = await redis.get(cacheKey);
    const redisTime = Date.now() - redisStart;
    
    if (cachedData) {
      const sendStart = Date.now();
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(cachedData));
      const sendTime = Date.now() - sendStart;
      console.log(`[Vercel/Redis] HIT page ${page} - Redis: ${redisTime}ms, Send: ${sendTime}ms, Total: ${Date.now() - startTime}ms`);
      return;
    }
    console.log(`[Vercel/Redis] MISS page ${page} - Redis lookup: ${redisTime}ms`);
  } catch (e) {
    console.error(`[Vercel/Redis] Redis error: ${e.message}`);
  }

  const url = `${WYNCRAFT_BASE}?page=${page}`;

  try {
    const apiStart = Date.now();
    const upstreamRes = await fetch(url);
    const rawText = await upstreamRes.text();
    const apiTime = Date.now() - apiStart;
    
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }
    
    console.log(`[Vercel/Redis] API page ${page} - Fetch: ${apiTime}ms, Parse done`);

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    const cacheStart = Date.now();
    try {
      await redis.setex(cacheKey, TTL, data);
      console.log(`[Vercel/Redis] Cached page ${page} - Cache write: ${Date.now() - cacheStart}ms`);
    } catch (e) {
      console.error(`[Vercel/Redis] Cache write error: ${e.message}`);
    }
    
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[Vercel/Redis] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
