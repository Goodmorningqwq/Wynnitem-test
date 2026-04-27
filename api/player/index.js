module.exports = async (req, res) => {
  // Robust parameter extraction for Vercel
  const urlParts = req.url.split('?')[0].split('/').filter(Boolean);
  const lastPathPart = urlParts.pop();
  
  const action = req.query.action || (lastPathPart === 'wars' ? 'wars' : null);
  const player = req.query.player || (lastPathPart !== 'index.js' && lastPathPart !== 'player' ? lastPathPart : null);

  // 1. Handle "wars" specialized endpoint
  if (action === 'wars') {
    const uuid = typeof req.query.uuid === 'string' ? req.query.uuid.trim() : '';
    if (!uuid) return res.status(400).json({ error: 'uuid required' });
    
    try {
      const response = await fetch(`https://api.wynncraft.com/v3/player/${encodeURIComponent(uuid)}`, {
        headers: { 
          'Accept': 'application/json',
          'User-Agent': 'Wynnitem-Tracker/1.0'
        }
      }).catch(() => null);

      if (!response) return res.status(503).json({ error: 'Upstream unavailable' });
      const data = await response.json().catch(() => null);
      if (!response.ok) return res.status(response.status).json({ error: data?.error || `API Error: ${response.status}` });

      return res.json({
        uuid: data?.uuid || uuid,
        username: data?.username || null,
        wars: Number(data?.globalData?.wars || 0)
      });
    } catch (e) {
      return res.status(503).json({ error: 'Upstream fetch failed' });
    }
  }

  // 2. Handle Profile Lookup (default)
  if (!player) {
    return res.status(400).json({ error: 'Player name or UUID required' });
  }

  const url = `https://api.wynncraft.com/v3/player/${encodeURIComponent(player)}?fullResult=true`;
  
  try {
    const upstreamRes = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Wynnitem-Tracker/1.0' }
    });
    
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
      return res.status(upstreamRes.status).json({ error: `API Error: ${upstreamRes.status}` });
    }
    
    const data = await upstreamRes.json();
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};
