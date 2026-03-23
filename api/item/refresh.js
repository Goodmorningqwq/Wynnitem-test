const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const FULL_DB_KEY = 'wynn_full_db';

async function buildFullDatabase() {
  const startTime = Date.now();
  const fullDb = {
    controller: { total: 0, count: 0 },
    results: {}
  };
  
  console.log(`[Refresh] Starting full DB rebuild...`);
  
  // First, try to get cached pages
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
        if (page % 50 === 0) {
          console.log(`[Refresh] Cached pages assembled: ${page}/276`);
        }
      }
    } catch (e) {
      console.error(`[Refresh] Error on cached page ${page}: ${e.message}`);
    }
  }
  
  console.log(`[Refresh] Cached pages: ${Object.keys(fullDb.results).length} items`);
  
  // Fetch any missing pages from Wynncraft API
  for (let page = 1; page <= 276; page++) {
    const cacheKey = `wynn_page_${page}`;
    
    try {
      const cachedPage = await redis.get(cacheKey);
      if (!cachedPage) {
        console.log(`[Refresh] Fetching missing page ${page} from API`);
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
      console.error(`[Refresh] Error on page ${page}: ${e.message}`);
    }
  }
  
  // Save full database
  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    console.log(`[Refresh] Saved FULL DB with ${fullDb.controller.total} items in ${Date.now() - startTime}ms`);
  } catch (e) {
    console.error(`[Refresh] Failed to save FULL DB: ${e.message}`);
  }
  
  return fullDb;
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization;
  
  // Simple auth check (you can make this more secure)
  if (authHeader !== `Bearer ${process.env.REFRESH_SECRET}` && process.env.REFRESH_SECRET) {
    // If no secret set, allow all (for testing)
    if (process.env.REFRESH_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  
  console.log(`[Refresh] Triggered at ${new Date().toISOString()}`);
  
  try {
    const result = await buildFullDatabase();
    
    res.setHeader('X-Cache', 'REFRESH-COMPLETE');
    return res.status(200).json({
      success: true,
      message: `Refresh complete. ${result.controller.total} items cached.`,
      items: result.controller.total,
      duration: `${Date.now() - performance.now()}ms`
    });
  } catch (e) {
    console.error(`[Refresh] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};

// Run immediately if called directly
if (require.main === module) {
  buildFullDatabase().then(() => process.exit(0)).catch(() => process.exit(1));
}
