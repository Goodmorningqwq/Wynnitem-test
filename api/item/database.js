const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const FULL_DB_KEY = 'wynn_full_db';
const LAST_GOOD_DB_KEY = 'wynn_full_db_last_good';
const DISCOVERED_PAGES_KEY = 'wynn_discovered_pages';

function safeParse(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

    if (fullDb?.results) {
      res.setHeader('X-Cache', 'FULL-HIT');
      if (Number.isFinite(discoveredPages) && discoveredPages > 0) {
        res.setHeader('X-Discovered-Pages', String(discoveredPages));
      }
      return res.status(200).json(fullDb);
    }

    if (lastGoodDb?.results) {
      res.setHeader('X-Cache', 'LAST-GOOD-HIT');
      if (Number.isFinite(discoveredPages) && discoveredPages > 0) {
        res.setHeader('X-Discovered-Pages', String(discoveredPages));
      }
      return res.status(200).json(lastGoodDb);
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
