const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const FULL_DB_KEY = 'wynn_full_db';
const PAGES_COUNT = 276;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, max-age=43200');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  const startTime = Date.now();
  const stats = { commands: 0, hits: 0, misses: 0 };
  
  // Check for full database cache (1 GET)
  try {
    const fullDb = await redis.get(FULL_DB_KEY);
    stats.commands++;
    if (fullDb) {
      const data = typeof fullDb === 'string' ? JSON.parse(fullDb) : fullDb;
      console.log(`[Vercel/database] FULL DB HIT - ${Object.keys(data.results || data).length} items in ${Date.now() - startTime}ms`);
      res.setHeader('X-Cache', 'FULL-HIT');
      return res.status(200).json(data);
    }
  } catch (e) {
    console.error(`[Vercel/database] Redis GET error: ${e.message}`);
  }
  
  console.log(`[Vercel/database] FULL DB MISS - Building from pages...`);
  
  // Batch fetch all cached pages at once (1 MGET = all pages)
  const cacheKeys = Array.from({ length: PAGES_COUNT }, (_, i) => `wynn_page_${i + 1}`);
  let cachedPages = {};
  
  try {
    const cachedData = await redis.mget(cacheKeys);
    stats.commands++; // 1 MGET command
    
    cachedData.forEach((pageData, index) => {
      if (pageData) {
        try {
          const parsed = typeof pageData === 'string' ? JSON.parse(pageData) : pageData;
          if (parsed.results) {
            cachedPages[`wynn_page_${index + 1}`] = parsed;
            stats.hits++;
          }
        } catch (e) {
          // Skip malformed data
        }
      }
    });
    console.log(`[Vercel/database] MGET: ${stats.hits}/${PAGES_COUNT} cached (1 command)`);
  } catch (e) {
    console.error(`[Vercel/database] MGET error: ${e.message}`);
  }
  
  // Build full database
  const fullDb = {
    controller: { total: 0, count: PAGES_COUNT },
    results: []
  };
  
  // Add all cached pages to full DB
  for (const [key, pageData] of Object.entries(cachedPages)) {
    const items = Array.isArray(pageData.results) ? pageData.results : Object.values(pageData.results || {});
    fullDb.results.push(...items);
    fullDb.controller.total += items.length;
  }
  
  // Fetch missing pages
  const missingPages = [];
  for (let i = 1; i <= PAGES_COUNT; i++) {
    if (!cachedPages[`wynn_page_${i}`]) {
      missingPages.push(i);
    }
  }
  
  for (const page of missingPages) {
    try {
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
        await redis.setex(`wynn_page_${page}`, TTL, pageData);
        stats.commands++; // 1 SETEX per page
        stats.misses++;
        const newItems = Array.isArray(pageData.results) ? pageData.results : Object.values(pageData.results || {});
        fullDb.results.push(...newItems);
        fullDb.controller.total += newItems.length;
        
        if (stats.misses % 20 === 0) {
          console.log(`[Vercel/database] Fetched ${stats.misses}/${missingPages.length} missing pages`);
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`[Vercel/database] Error page ${page}: ${e.message}`);
    }
  }
  
  // Cache full database (1 SET)
  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    stats.commands++; // 1 SET command
    console.log(`[Vercel/database] Cached FULL DB: ${fullDb.controller.total} items`);
  } catch (e) {
    console.error(`[Vercel/database] SET error: ${e.message}`);
  }
  
  console.log(`[Vercel/database] Total commands: ${stats.commands}, Hits: ${stats.hits}, Misses: ${stats.misses}`);
  
  res.setHeader('X-Cache', 'FULL-MISS');
  return res.status(200).json(fullDb);
};
