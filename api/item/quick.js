module.exports = async function handler(req, res) {
  const query = req.query.query || '';
  const cacheKey = `quick_${query}`;
  
  console.log(`[Vercel/quick] Query: "${query}", Cache key: "${cacheKey}"`);
  console.log(`[Vercel/quick] Cache exists: ${!!global.quickCache}, Has key: ${!!global.quickCache?.[cacheKey]}`);
  
  const cached = global.quickCache?.[cacheKey];
  const now = Date.now();
  
  if (cached) {
    const isExpired = now >= cached.expiresAt;
    const ttlRemaining = cached.expiresAt - now;
    console.log(`[Vercel/quick] Cached found, expired: ${isExpired}, TTL remaining: ${ttlRemaining}ms`);
    
    if (!isExpired) {
      res.setHeader('X-Cache', 'HIT');
      console.log(`[Vercel/quick] Returning cached data`);
      return res.status(200).json(cached.data);
    } else {
      console.log(`[Vercel/quick] Cache expired, fetching fresh data`);
    }
  } else {
    console.log(`[Vercel/quick] No cache found, fetching from API`);
  }

  const url = `https://api.wynncraft.com/v3/item/search/${encodeURIComponent(query)}`;
  console.log(`[Vercel/quick] Fetching from: ${url}`);

  try {
    const upstreamRes = await fetch(url);
    const data = await upstreamRes.json();

    console.log(`[Vercel/quick] Upstream status: ${upstreamRes.status}, Data keys: ${Object.keys(data).length}`);

    if (!upstreamRes.ok) {
      console.log(`[Vercel/quick] Upstream error: ${upstreamRes.status}`);
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    if (!global.quickCache) {
      console.log(`[Vercel/quick] Initializing new cache object`);
      global.quickCache = {};
    }
    
    const TTL = 12 * 60 * 60 * 1000; // 12 hours
    global.quickCache[cacheKey] = {
      data,
      expiresAt: now + TTL
    };
    console.log(`[Vercel/quick] Cached with TTL: ${TTL}ms, expires at: ${now + TTL}`);

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error(`[Vercel/quick] Error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
};
