module.exports = async (req, res) => {
  // Robust parameter extraction using standard URL API
  const urlObj = new URL(req.url, 'http://localhost');
  const player = req.query?.player || req.query?.uuid || urlObj.searchParams.get('player') || urlObj.searchParams.get('uuid');

  if (!player) {
    const parts = urlObj.pathname.split('/').filter(Boolean);
    const last = parts.pop();
    // If URL was /api/player/Aerrihn, last is Aerrihn
    if (last && last !== 'player') {
      return res.status(400).json({ error: 'Player name required', debugPath: last });
    }
    return res.status(400).json({ error: 'Player name or UUID required', debugUrl: req.url });
  }

  const action = req.query?.action || urlObj.searchParams.get('action') || (urlObj.pathname.includes('/wars') ? 'wars' : null);

  // 1. Handle "wars" specialized endpoint
  if (action === 'wars') {
    const uuid = typeof player === 'string' ? player.trim() : '';
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
    return res.status(400).json({ 
      error: 'Player name or UUID required',
      debug: { query: req.query, url: req.url }
    });
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
