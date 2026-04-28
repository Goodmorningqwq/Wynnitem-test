const { Redis } = require('@upstash/redis');

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const TTL = 12 * 60 * 60; // 12 hours in seconds
const LAST_GOOD_TTL = 30 * 24 * 60 * 60; // 30 days in seconds
const FULL_DB_KEY = 'wynn_full_db';
const LAST_GOOD_DB_KEY = 'wynn_full_db_last_good';
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';
const REFRESH_LOCK_KEY = 'wynn_refresh_lock';
const REFRESH_LOCK_TTL_SECONDS = 15 * 60;
const MAX_PAGES_GUARD = 600;
const PAGE_FETCH_DELAY_MS = 350;
const MAX_CONSECUTIVE_DISCOVERY_ERRORS = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeItems(results) {
  if (Array.isArray(results)) return results;
  if (results && typeof results === 'object') return Object.values(results);
  return [];
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

async function getKnownPageCount() {
  try {
    const raw = await redis.get(DISCOVERED_PAGES_KEY);
    const parsed = Number(raw || 0);
    if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, MAX_PAGES_GUARD);
  } catch (e) {
    console.error(`[Refresh] Failed to read discovered page count: ${e.message}`);
  }
  return 1;
}

async function readCachedPage(page) {
  try {
    const cached = await redis.get(`wynn_page_${page}`);
    const parsed = safeParse(cached);
    if (parsed?.results) {
      return { ok: true, items: normalizeItems(parsed.results), source: 'cache' };
    }
  } catch (e) {
    console.error(`[Refresh] Cache read error page ${page}: ${e.message}`);
  }
  return { ok: false, items: [], source: 'cache-miss' };
}

async function fetchAndCachePage(page, stats) {
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const url = `${WYNCRAFT_BASE}?page=${page}`;
      const upstreamRes = await fetch(url);
      const rawText = await upstreamRes.text();
      const parsed = safeParse(rawText);

      if (!upstreamRes.ok) {
        if (upstreamRes.status === 429 && attempts < 2) {
          const retryAfter = Math.max(1, Number(upstreamRes.headers.get('Retry-After') || 1));
          await sleep(retryAfter * 1000);
          continue;
        }
        stats.errors += 1;
        return { ok: false, items: [], source: `upstream-${upstreamRes.status}`, empty: false };
      }

      const items = normalizeItems(parsed?.results);
      if (!items.length) {
        return { ok: true, items: [], source: 'upstream-empty', empty: true };
      }

      await redis.setex(`wynn_page_${page}`, TTL, parsed);
      stats.commands += 1;
      stats.pageMisses += 1;
      return { ok: true, items, source: 'upstream', empty: false };
    } catch (e) {
      if (attempts >= 2) {
        stats.errors += 1;
        console.error(`[Refresh] Error page ${page}: ${e.message}`);
        return { ok: false, items: [], source: 'upstream-error', empty: false };
      }
    }
  }
  return { ok: false, items: [], source: 'upstream-error', empty: false };
}

async function getPageItems(page, stats) {
  const cached = await readCachedPage(page);
  if (cached.ok && cached.items.length) {
    stats.pageHits += 1;
    return cached;
  }
  return fetchAndCachePage(page, stats);
}

async function acquireRefreshLock() {
  try {
    const result = await redis.set(REFRESH_LOCK_KEY, String(Date.now()), {
      nx: true,
      ex: REFRESH_LOCK_TTL_SECONDS
    });
    return Boolean(result);
  } catch (e) {
    console.error(`[Refresh] Lock acquisition failed: ${e.message}`);
    return false;
  }
}

async function releaseRefreshLock() {
  try {
    await redis.del(REFRESH_LOCK_KEY);
  } catch (e) {
    console.error(`[Refresh] Failed to release lock: ${e.message}`);
  }
}

async function buildFullDatabase() {
  const startTime = Date.now();
  const stats = { commands: 0, pageHits: 0, pageMisses: 0, errors: 0 };
  const knownPageCount = await getKnownPageCount();
  let discoveredPageCount = 0;
  let consecutiveDiscoveryErrors = 0;

  const fullDb = {
    controller: { total: 0, count: 0 },
    results: []
  };

  console.log(`[Refresh] Starting rebuild with known page count ${knownPageCount}`);

  // Phase 1: hydrate known pages quickly.
  for (let page = 1; page <= knownPageCount; page += 1) {
    const pageResult = await getPageItems(page, stats);
    if (pageResult.ok && pageResult.items.length) {
      discoveredPageCount = page;
      fullDb.results.push(...pageResult.items);
      fullDb.controller.total += pageResult.items.length;
    } else if (!pageResult.ok) {
      console.error(`[Refresh] Failed known page ${page} (${pageResult.source})`);
    }
    await sleep(PAGE_FETCH_DELAY_MS);
  }

  // Phase 2: discover new pages Wynncraft may have added.
  for (let page = knownPageCount + 1; page <= MAX_PAGES_GUARD; page += 1) {
    const pageResult = await getPageItems(page, stats);
    if (pageResult.ok && pageResult.items.length) {
      discoveredPageCount = page;
      consecutiveDiscoveryErrors = 0;
      fullDb.results.push(...pageResult.items);
      fullDb.controller.total += pageResult.items.length;
      await sleep(PAGE_FETCH_DELAY_MS);
      continue;
    }

    if (pageResult.ok && pageResult.empty) {
      break;
    }

    consecutiveDiscoveryErrors += 1;
    if (consecutiveDiscoveryErrors >= MAX_CONSECUTIVE_DISCOVERY_ERRORS) {
      console.error(`[Refresh] Discovery stopped after ${consecutiveDiscoveryErrors} consecutive errors`);
      break;
    }
  }

  if (!fullDb.results.length) {
    throw new Error('No item pages available to build snapshot');
  }

  fullDb.controller.count = Math.max(discoveredPageCount, 1);

  try {
    await redis.set(FULL_DB_KEY, JSON.stringify(fullDb), { ex: TTL });
    await redis.set(LAST_GOOD_DB_KEY, JSON.stringify(fullDb), { ex: LAST_GOOD_TTL });
    await redis.set(DISCOVERED_PAGES_KEY, String(fullDb.controller.count), { ex: LAST_GOOD_TTL });
    stats.commands += 3;
    console.log(`[Refresh] Saved snapshots with ${fullDb.controller.total} items across ${fullDb.controller.count} pages`);
  } catch (e) {
    throw new Error(`Failed to save snapshots: ${e.message}`);
  }

  return { fullDb, stats, discoveredPageCount: fullDb.controller.count, totalTime: Date.now() - startTime };
}

module.exports = async function handler(req, res) {
  // Allow either cron trigger or explicit admin token.
  const isCron = req.headers['x-vercel-cron'] === '1';
  const providedAdminToken = String(req.headers['x-cache-admin-token'] || req.query.token || '');
  const expectedAdminToken = String(process.env.CACHE_ADMIN_TOKEN || '');
  const isManualAdmin = Boolean(expectedAdminToken) && providedAdminToken === expectedAdminToken;

  if (!isCron && !isManualAdmin) {
    console.log('[Refresh] Unauthorized access attempt blocked');
    return res.status(403).json({
      success: false,
      error: 'Forbidden - requires cron header or valid admin token'
    });
  }
  
  const triggerType = isCron ? 'cron' : 'manual-admin';
  console.log(`[Refresh] ${triggerType} triggered at ${new Date().toISOString()}`);
  
  const lockAcquired = await acquireRefreshLock();
  if (!lockAcquired) {
    return res.status(409).json({
      success: false,
      alreadyRunning: true,
      error: 'Refresh already running'
    });
  }

  try {
    const result = await buildFullDatabase();
    return res.status(200).json({
      success: true,
      trigger: triggerType,
      items: result.fullDb.controller.total,
      pages: result.discoveredPageCount,
      commands: result.stats.commands,
      pageHits: result.stats.pageHits,
      pageMisses: result.stats.pageMisses,
      errors: result.stats.errors,
      duration: `${result.totalTime}ms`
    });
  } catch (e) {
    console.error(`[Refresh] Error: ${e.message}`);
    return res.status(500).json({
      success: false,
      alreadyRunning: false,
      error: e.message
    });
  } finally {
    await releaseRefreshLock();
  }
};
