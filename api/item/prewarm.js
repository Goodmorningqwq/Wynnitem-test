const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  const results = {
    cached: 0,
    fetched: 0,
    errors: [],
    pages: []
  };
  
  for (let page = 1; page <= 276; page++) {
    const cacheKey = `wynn_page_${page}`;
    
    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        results.cached++;
        results.pages.push({ page, status: 'HIT' });
        console.log(`[Prewarm] Page ${page}: HIT`);
        continue;
      }
      
      console.log(`[Prewarm] Page ${page}: MISS, fetching...`);
      
      const url = `${WYNCRAFT_BASE}?page=${page}`;
      const upstreamRes = await fetch(url);
      const rawText = await upstreamRes.text();
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : null;
      } catch {
        data = rawText;
      }
      
      if (!upstreamRes.ok) {
        results.errors.push({ page, error: `HTTP ${upstreamRes.status}` });
        results.pages.push({ page, status: `ERROR-${upstreamRes.status}` });
        console.log(`[Prewarm] Page ${page}: ERROR ${upstreamRes.status}`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      
      await redis.setex(cacheKey, TTL, data);
      results.fetched++;
      results.pages.push({ page, status: 'FETCHED' });
      console.log(`[Prewarm] Page ${page}: FETCHED`);
      
      await new Promise(r => setTimeout(r, 1500));
      
    } catch (e) {
      results.errors.push({ page, error: e.message });
      results.pages.push({ page, status: `ERROR-${e.message}` });
      console.error(`[Prewarm] Page ${page}: ERROR ${e.message}`);
    }
  }
  
  res.setHeader('X-Cache', 'PREWARM-COMPLETE');
  return res.status(200).json({
    message: `Pre-warm complete. Cached: ${results.cached}, Fetched: ${results.fetched}`,
    summary: results
  });
};
