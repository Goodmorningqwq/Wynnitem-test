module.exports = async function handler(req, res) {
  const url = 'https://api.wynncraft.com/v3/item/metadata';
  const cacheKey = 'metadata';

  const cached = global.metadataCache?.[cacheKey];
  if (cached && Date.now() < cached.expiresAt) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cached.data);
  }

  try {
    const upstreamRes = await fetch(url);
    const data = await upstreamRes.json();

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    if (!global.metadataCache) global.metadataCache = {};
    global.metadataCache[cacheKey] = {
      data,
      expiresAt: Date.now() + 60 * 60 * 1000
    };

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};