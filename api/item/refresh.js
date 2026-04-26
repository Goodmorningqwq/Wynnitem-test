const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const FULL_DB_KEY = 'wynn_full_db';
const PAGES_COUNT = 276;

async function buildFullDatabase() {
  const startTime = Date.now();
  const stats = { commands: 0, hits: 0, misses: 0, errors: 0 };
  
  console.log(`[Refresh] Starting full DB rebuild...`);
  
  const cacheKeys = Array.from({ length: PAGES_COUNT }, (_, i) => `wynn_page_${i + 1}`);
  let allCachedPages = {};
  
  try {
    const cachedData = await redis.mget(cacheKeys);
    stats.commands++;
    
    cachedData.forEach((pageData, index) => {
      if (pageData) {
        try {
          const parsed = typeof pageData === 'string' ? JSON.parse(pageData) : pageData;
          if (parsed.results) {
            allCachedPages[`wynn_page_${index + 1}`] = parsed;
            stats.hits++;
          }
        } catch (e) {
          console.error(`[Refresh] Parse error page ${index + 1}`);
        }
      }
    });
    console.log(`[Refresh] MGET: ${stats.hits}/${PAGES_COUNT} pages cached`);
  } catch (e) {
    console.error(`[Refresh] MGET error: ${e.message}`);
    stats.errors++;
  }
  
  const missingPages = [];
  for (let i = 1; i <= PAGES_COUNT; i++) {
    if (!allCachedPages[`wynn_page_${i}`]) {
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
        stats.commands++;
        stats.misses++;
        allCachedPages[`wynn_page_${page}`] = pageData;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`[Refresh] Error page ${page}: ${e.message}`);
      stats.errors++;
    }
  }
  
  const fullDb = {
    controller: { total: 0, count: PAGES_COUNT },
    results: []
  };
  
  for (const [key, pageData] of Object.entries(allCachedPages)) {
    if (pageData.results) {
      const items = Array.isArray(pageData.results) ? pageData.results : Object.values(pageData.results || {});
      fullDb.results.push(...items);
      fullDb.controller.total += items.length;
    }
  }
  
  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    stats.commands++;
    console.log(`[Refresh] Saved FULL DB: ${fullDb.controller.total} items`);
  } catch (e) {
    console.error(`[Refresh] Failed to save FULL DB: ${e.message}`);
    stats.errors++;
  }
  
  console.log(`[Refresh] Complete! Commands: ${stats.commands}, Hits: ${stats.hits}, Misses: ${stats.misses}`);
  
  return { fullDb, stats, totalTime: Date.now() - startTime };
}

module.exports = async function handler(req, res) {
  // Only allow cron-triggered calls (Vercel sets this header)
  const isCron = req.headers['x-vercel-cron'] === '1';
  
  if (!isCron) {
    console.log(`[Refresh] Unauthorized access attempt blocked`);
    return res.status(403).json({ error: 'Forbidden - cron only' });
  }
  
  console.log(`[Refresh] Cron triggered at ${new Date().toISOString()}`);
  
  try {
    const result = await buildFullDatabase();
    
    return res.status(200).json({
      success: true,
      items: result.fullDb.controller.total,
      commands: result.stats.commands,
      cacheHits: result.stats.hits,
      cacheMisses: result.stats.misses,
      duration: `${result.totalTime}ms`
    });
  } catch (e) {
    console.error(`[Refresh] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
