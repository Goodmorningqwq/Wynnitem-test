const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const pageCache = new Map();

module.exports = async function handler(req, res) {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `page_${page}`;

  if (pageCache.has(cacheKey)) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(pageCache.get(cacheKey));
  }

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

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }

    pageCache.set(cacheKey, data);
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};