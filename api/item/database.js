const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FULL_DB_KEY = 'wynn_full_db';
const LAST_GOOD_DB_KEY = 'wynn_full_db_last_good';
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';
const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';
const TTL = 12 * 60 * 60; // 12 hours in seconds
const LAST_GOOD_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const PAGE_KEY_PREFIX = 'wynn_page_';
const MAX_REBUILD_PAGES_FALLBACK = 180;
const REBUILD_BATCH_SIZE = 20;
const UPSTREAM_REBUILD_TIME_BUDGET_MS = 8500;
const UPSTREAM_REBUILD_PAGE_CAP = 40;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchUpstreamPage(page) {
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    const response = await fetch(`${WYNCRAFT_BASE}?page=${page}`);
    const text = await response.text();
    const payload = safeParse(text);

    if (!response.ok) {
      if (response.status === 429 && attempts < 2) {
        const retryAfterSec = Math.max(1, Number(response.headers.get('Retry-After') || 1));
        await sleep(retryAfterSec * 1000);
        continue;
      }
      return { ok: false, status: response.status, payload: null, items: [] };
    }

    const items = normalizeItems(payload?.results);
    return { ok: true, status: 200, payload, items };
  }
  return { ok: false, status: 0, payload: null, items: [] };
}

async function rebuildSnapshotFromUpstream(knownPages) {
  const start = Date.now();
  let maxPages = Math.max(1, Math.min(knownPages || 1, UPSTREAM_REBUILD_PAGE_CAP));
  let discoveredPages = 0;
  const allItems = [];

  for (let page = 1; page <= maxPages; page += 1) {
    if (Date.now() - start > UPSTREAM_REBUILD_TIME_BUDGET_MS) break;

    const result = await fetchUpstreamPage(page);
    if (!result.ok) break;
    if (!result.items.length) break;

    discoveredPages = page;
    allItems.push(...result.items);
    await redis.setex(`${PAGE_KEY_PREFIX}${page}`, TTL, result.payload);

    const hintedPages = Number(result.payload?.controller?.count || 0);
    if (Number.isFinite(hintedPages) && hintedPages > maxPages) {
      maxPages = Math.min(hintedPages, UPSTREAM_REBUILD_PAGE_CAP);
    }
  }

  if (!allItems.length) return null;
  return {
    controller: { total: allItems.length, count: Math.max(discoveredPages, 1) },
    results: allItems
  };
}

module.exports = async function handler(req, res) {
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
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=1800');
      res.setHeader('X-Cache', 'FULL-HIT');
      if (Number.isFinite(discoveredPages) && discoveredPages > 0) {
        res.setHeader('X-Discovered-Pages', String(discoveredPages));
      }
      return res.status(200).json(fullDb);
    }

    if (Array.isArray(lastGoodDb?.results) && lastGoodDb.results.length > 0) {
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=1800');
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
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=1800');
      res.setHeader('X-Cache', 'PAGE-REBUILD-HIT');
      res.setHeader('X-Discovered-Pages', String(rebuilt.controller.count));
      return res.status(200).json(rebuilt);
    }

    // Final self-heal: bootstrap directly from upstream within a strict time budget.
    const rebuiltFromUpstream = await rebuildSnapshotFromUpstream(discoveredPages);
    if (rebuiltFromUpstream?.results?.length) {
      await redis.set(FULL_DB_KEY, JSON.stringify(rebuiltFromUpstream), { ex: TTL });
      await redis.set(LAST_GOOD_DB_KEY, JSON.stringify(rebuiltFromUpstream), { ex: LAST_GOOD_TTL });
      await redis.set(DISCOVERED_PAGES_KEY, String(rebuiltFromUpstream.controller.count), { ex: LAST_GOOD_TTL });
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=1800');
      res.setHeader('X-Cache', 'UPSTREAM-BOOTSTRAP-HIT');
      res.setHeader('X-Discovered-Pages', String(rebuiltFromUpstream.controller.count));
      return res.status(200).json(rebuiltFromUpstream);
    }
  } catch (e) {
    console.error(`[Vercel/database] Snapshot read error: ${e.message}`);
  }

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Cache', 'EMPTY');
  res.setHeader('Retry-After', '60');
  return res.status(503).json({
    error: 'Item database snapshot unavailable. Refresh is warming cache.',
    code: 'ITEM_DB_SNAPSHOT_EMPTY'
  });
};
