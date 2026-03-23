const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const FULL_DB_KEY = 'wynn_full_db';

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=43200');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const startTime = Date.now();
  
  // Check for full database cache
  try {
    const fullDb = await redis.get(FULL_DB_KEY);
    if (fullDb) {
      const data = typeof fullDb === 'string' ? JSON.parse(fullDb) : fullDb;
      console.log(`[Vercel/database] Serving FULL DB cache - ${Object.keys(data.results || data).length} items in ${Date.now() - startTime}ms`);
      res.setHeader('X-Cache', 'FULL-HIT');
      return res.status(200).json(data);
    }
  } catch (e) {
    console.error(`[Vercel/database] Redis GET error: ${e.message}`);
  }
  
  console.log(`[Vercel/database] FULL DB MISS - Building from pages...`);
  
  // Build full database from pages
  const fullDb = {
    controller: { total: 0, count: 0 },
    results: {}
  };
  
  for (let page = 1; page <= 276; page++) {
    const cacheKey = `wynn_page_${page}`;
    
    try {
      const cachedPage = await redis.get(cacheKey);
      if (cachedPage) {
        const pageData = typeof cachedPage === 'string' ? JSON.parse(cachedPage) : cachedPage;
        if (pageData.results) {
          Object.assign(fullDb.results, pageData.results);
          fullDb.controller.total += Object.keys(pageData.results).length;
        }
        console.log(`[Vercel/database] Assembled page ${page} from cache`);
      } else {
        // Fetch missing page
        console.log(`[Vercel/database] Fetching missing page ${page} from API`);
        const url = `${WYNCRAFT_BASE}?page=${page}`;
        const upstreamRes = await fetch(url);
        const rawText = await upstreamRes.text();
        let pageData;
        try {
          pageData = rawText ? JSON.parse(rawText) : null;
        } catch {
          pageData = rawText;
        }
        
        if (upstreamRes.ok && pageData?.results) {
          await redis.setex(cacheKey, TTL, pageData);
          Object.assign(fullDb.results, pageData.results);
          fullDb.controller.total += Object.keys(pageData.results).length;
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`[Vercel/database] Error on page ${page}: ${e.message}`);
    }
  }
  
  // Cache the full database
  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    console.log(`[Vercel/database] Cached FULL DB with ${fullDb.controller.total} items`);
  } catch (e) {
    console.error(`[Vercel/database] Failed to cache FULL DB: ${e.message}`);
  }
  
  res.setHeader('X-Cache', 'FULL-MISS');
  console.log(`[Vercel/database] Served FULL DB - ${fullDb.controller.total} items in ${Date.now() - startTime}ms`);
  return res.status(200).json(fullDb);
};
