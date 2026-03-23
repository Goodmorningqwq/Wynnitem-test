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
  
  // Build cache keys
  const cacheKeys = Array.from({ length: PAGES_COUNT }, (_, i) => `wynn_page_${i + 1}`);
  
  // Batch fetch all cached pages at once (MGET is more efficient)
  let allCachedPages = {};
  try {
    const cachedData = await redis.mget(cacheKeys);
    stats.commands++; // 1 MGET command for all pages
    
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
    console.log(`[Refresh] MGET: ${stats.hits}/${PAGES_COUNT} pages cached (1 command)`);
  } catch (e) {
    console.error(`[Refresh] MGET error: ${e.message}`);
    stats.errors++;
  }
  
  // Find missing pages
  const missingPages = [];
  for (let i = 1; i <= PAGES_COUNT; i++) {
    if (!allCachedPages[`wynn_page_${i}`]) {
      missingPages.push(i);
    }
  }
  
  console.log(`[Refresh] Missing pages: ${missingPages.length}`);
  
  // Fetch missing pages one by one
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
        allCachedPages[`wynn_page_${page}`] = pageData;
        
        if (missingPages.indexOf(page) % 20 === 0) {
          console.log(`[Refresh] Fetched page ${page} (${stats.misses}/${missingPages.length})`);
        }
        
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (e) {
      console.error(`[Refresh] Error page ${page}: ${e.message}`);
      stats.errors++;
    }
  }
  
  // Build full database from cached pages
  const fullDb = {
    controller: { total: 0, count: PAGES_COUNT },
    results: {}
  };
  
  for (const [key, pageData] of Object.entries(allCachedPages)) {
    if (pageData.results) {
      Object.assign(fullDb.results, pageData.results);
      fullDb.controller.total += Object.keys(pageData.results).length;
    }
  }
  
  // Save full database (1 SET command)
  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    stats.commands++; // 1 SET command
    console.log(`[Refresh] Saved FULL DB: ${fullDb.controller.total} items`);
  } catch (e) {
    console.error(`[Refresh] Failed to save FULL DB: ${e.message}`);
    stats.errors++;
  }
  
  const totalTime = Date.now() - startTime;
  console.log(`[Refresh] Complete! Commands: ${stats.commands}, Hits: ${stats.hits}, Misses: ${stats.misses}, Time: ${totalTime}ms`);
  
  return { fullDb, stats, totalTime };
}

module.exports = async function handler(req, res) {
  console.log(`[Refresh] Triggered at ${new Date().toISOString()}`);
  
  try {
    const result = await buildFullDatabase();
    
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({
      success: true,
      items: result.fullDb.controller.total,
      commands: result.stats.commands,
      cacheHits: result.stats.hits,
      cacheMisses: result.stats.misses,
      errors: result.stats.errors,
      duration: `${result.totalTime}ms`
    });
  } catch (e) {
    console.error(`[Refresh] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};

if (require.main === module) {
  buildFullDatabase().then(() => process.exit(0)).catch(() => process.exit(1));
}
