const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

module.exports = async function handler(req, res) {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `page_${page}`;
  
  console.log(`[Vercel/database] Page: ${page}, Cache key: "${cacheKey}"`);
  console.log(`[Vercel/database] Cache has key: ${!!pageCache.has(cacheKey)}`);

  if (pageCache.has(cacheKey)) {
    res.setHeader('X-Cache', 'HIT');
    console.log(`[Vercel/database] Cache HIT, returning cached page ${page}`);
    return res.status(200).json(pageCache.get(cacheKey));
  }
  
  console.log(`[Vercel/database] Cache MISS, fetching page ${page} from API`);

  const url = `${WYNCRAFT_BASE}?page=${page}`;

  try {
    const upstreamRes = await fetch(url);
    const rawText = await upstreamRes.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }

    console.log(`[Vercel/database] Upstream status: ${upstreamRes.status}`);

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    pageCache.set(cacheKey, data);
    res.setHeader('X-Cache', 'MISS');
    console.log(`[Vercel/database] Cached page ${page}, total cached: ${pageCache.size}`);
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[Vercel/database] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
