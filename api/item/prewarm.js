const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';
const MAX_PAGES_GUARD = 600;
const PAGE_FETCH_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeItems(results) {
  if (Array.isArray(results)) return results;
  if (results && typeof results === 'object') return Object.values(results);
  return [];
}

async function getKnownPageCount() {
  try {
    const raw = await redis.get(DISCOVERED_PAGES_KEY);
    const parsed = Number(raw || 0);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_PAGES_GUARD);
  } catch (e) {
    console.error(`[Prewarm] Failed to read discovered page count: ${e.message}`);
  }
  return 1;
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  
  const results = {
    cached: 0,
    fetched: 0,
    errors: [],
    pages: []
  };
  
  const knownPageCount = await getKnownPageCount();
  let discoveredPageCount = 0;
  let consecutiveDiscoveryErrors = 0;

  const processPage = async (page) => {
    const cacheKey = `wynn_page_${page}`;

    try {
      const cachedData = await redis.get(cacheKey);
      if (cachedData) {
        const parsed = safeParse(cachedData);
        const items = normalizeItems(parsed?.results);
        if (!items.length) {
          results.pages.push({ page, status: 'EMPTY-CACHED' });
          return { ok: true, empty: true };
        }
        results.cached++;
        discoveredPageCount = Math.max(discoveredPageCount, page);
        results.pages.push({ page, status: 'HIT' });
        console.log(`[Prewarm] Page ${page}: HIT`);
        return { ok: true, empty: false };
      }

      console.log(`[Prewarm] Page ${page}: MISS, fetching...`);

      const url = `${WYNCRAFT_BASE}?page=${page}`;
      const upstreamRes = await fetch(url);
      const rawText = await upstreamRes.text();
      const data = safeParse(rawText);

      if (!upstreamRes.ok) {
        results.errors.push({ page, error: `HTTP ${upstreamRes.status}` });
        results.pages.push({ page, status: `ERROR-${upstreamRes.status}` });
        console.log(`[Prewarm] Page ${page}: ERROR ${upstreamRes.status}`);
        return { ok: false, empty: false };
      }

      const items = normalizeItems(data?.results);
      if (!items.length) {
        results.pages.push({ page, status: 'EMPTY' });
        console.log(`[Prewarm] Page ${page}: EMPTY`);
        return { ok: true, empty: true };
      }

      await redis.setex(cacheKey, TTL, data);
      results.fetched++;
      discoveredPageCount = Math.max(discoveredPageCount, page);
      results.pages.push({ page, status: 'FETCHED' });
      console.log(`[Prewarm] Page ${page}: FETCHED`);
      return { ok: true, empty: false };
    } catch (e) {
      results.errors.push({ page, error: e.message });
      results.pages.push({ page, status: `ERROR-${e.message}` });
      console.error(`[Prewarm] Page ${page}: ERROR ${e.message}`);
      return { ok: false, empty: false };
    }
  };

  for (let page = 1; page <= knownPageCount; page += 1) {
    await processPage(page);
    await sleep(PAGE_FETCH_DELAY_MS);
  }

  for (let page = knownPageCount + 1; page <= MAX_PAGES_GUARD; page += 1) {
    const outcome = await processPage(page);
    if (outcome.ok && outcome.empty) {
      break;
    }
    if (!outcome.ok) {
      consecutiveDiscoveryErrors += 1;
      if (consecutiveDiscoveryErrors >= 3) break;
    } else {
      consecutiveDiscoveryErrors = 0;
    }
    await sleep(PAGE_FETCH_DELAY_MS);
  }

  if (discoveredPageCount > 0) {
    await redis.set(DISCOVERED_PAGES_KEY, String(discoveredPageCount), { ex: 30 * 24 * 60 * 60 });
  }

  res.setHeader('X-Cache', 'PREWARM-COMPLETE');
  return res.status(200).json({
    message: `Pre-warm complete. Cached: ${results.cached}, Fetched: ${results.fetched}`,
    discoveredPages: discoveredPageCount,
    summary: results
  });
};
