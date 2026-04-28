const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FULL_DB_KEY = 'wynn_full_db';
const LAST_GOOD_DB_KEY = 'wynn_full_db_last_good';
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';
const TTL = 12 * 60 * 60; // 12 hours in seconds
const LAST_GOOD_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const PAGE_KEY_PREFIX = 'wynn_page_';
const MAX_REBUILD_PAGES_FALLBACK = 180;
const REBUILD_BATCH_SIZE = 20;

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

function buildPageKeys(maxPage) {
  const keys = [];
  for (let page = 1; page <= maxPage; page += 1) {
    keys.push(`${PAGE_KEY_PREFIX}${page}`);
  }
  return keys;
}

async function rebuildSnapshotFromPageCache(knownPages) {
  const pageLimit = Math.max(1, Math.min(knownPages || MAX_REBUILD_PAGES_FALLBACK, MAX_REBUILD_PAGES_FALLBACK));
  const pageKeys = buildPageKeys(pageLimit);
  const allItems = [];
  let discoveredPages = 0;

  for (let i = 0; i < pageKeys.length; i += REBUILD_BATCH_SIZE) {
    const chunk = pageKeys.slice(i, i + REBUILD_BATCH_SIZE);
    const values = await redis.mget(chunk);
    for (let j = 0; j < values.length; j += 1) {
      const parsed = safeParse(values[j]);
      const items = normalizeItems(parsed?.results);
      if (items.length) {
        const pageNum = i + j + 1;
        discoveredPages = Math.max(discoveredPages, pageNum);
        allItems.push(...items);
      }
    }
  }

  if (!allItems.length) {
    return null;
  }

  return {
    controller: {
      total: allItems.length,
      count: Math.max(discoveredPages, 1)
    },
    results: allItems
  };
}

module.exports = async function handler(req, res) {
  // Let Vercel Edge cache briefly; Redis remains source of truth.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=43200, stale-while-revalidate=86400');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    const [fullDbRaw, lastGoodRaw, discoveredPagesRaw] = await redis.mget([
      FULL_DB_KEY,
      LAST_GOOD_DB_KEY,
      DISCOVERED_PAGES_KEY
    ]);
    const fullDb = safeParse(fullDbRaw);
    const lastGoodDb = safeParse(lastGoodRaw);
    const discoveredPages = Number(discoveredPagesRaw || 0);

    if (Array.isArray(fullDb?.results) && fullDb.results.length > 0) {
      res.setHeader('X-Cache', 'FULL-HIT');
      if (Number.isFinite(discoveredPages) && discoveredPages > 0) {
        res.setHeader('X-Discovered-Pages', String(discoveredPages));
      }
      return res.status(200).json(fullDb);
    }

    if (Array.isArray(lastGoodDb?.results) && lastGoodDb.results.length > 0) {
      res.setHeader('X-Cache', 'LAST-GOOD-HIT');
      if (Number.isFinite(discoveredPages) && discoveredPages > 0) {
        res.setHeader('X-Discovered-Pages', String(discoveredPages));
      }
      return res.status(200).json(lastGoodDb);
    }

    // Self-heal path: rebuild a temporary full snapshot from cached pages.
    const rebuilt = await rebuildSnapshotFromPageCache(discoveredPages);
    if (rebuilt?.results?.length) {
      await redis.set(FULL_DB_KEY, JSON.stringify(rebuilt), { ex: TTL });
      await redis.set(LAST_GOOD_DB_KEY, JSON.stringify(rebuilt), { ex: LAST_GOOD_TTL });
      await redis.set(DISCOVERED_PAGES_KEY, String(rebuilt.controller.count), { ex: LAST_GOOD_TTL });
      res.setHeader('X-Cache', 'PAGE-REBUILD-HIT');
      res.setHeader('X-Discovered-Pages', String(rebuilt.controller.count));
      return res.status(200).json(rebuilt);
    }
  } catch (e) {
    console.error(`[Vercel/database] Snapshot read error: ${e.message}`);
  }

  res.setHeader('X-Cache', 'EMPTY');
  res.setHeader('Retry-After', '60');
  return res.status(503).json({
    error: 'Item database snapshot unavailable. Refresh is warming cache.',
    code: 'ITEM_DB_SNAPSHOT_EMPTY'
  });
};
