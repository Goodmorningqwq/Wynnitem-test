module.exports = async (req, res) => {
  // Extract player name from the query (when using [player].js) or URL
  const player = req.query.player || req.url.split('/').pop().split('?')[0];
  
  if (!player || player === '[player].js' || player === 'index.js') {
    return res.status(400).json({ error: 'Player name or UUID required' });
  }

  const url = `https://api.wynncraft.com/v3/player/${encodeURIComponent(player)}?fullResult=true`;
  
  try {
    const upstreamRes = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Wynnitem-Tracker/1.0'
      }
    });
    
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        return res.status(429).json({ error: 'Wynncraft API rate limit exceeded' });
      }
      return res.status(upstreamRes.status).json({ error: `Wynncraft API Error: ${upstreamRes.status}` });
    }
    
    const data = await upstreamRes.json();
    
    // Cache for 10 minutes on the edge, allow 10m stale grace
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
    return res.json(data);
  } catch (err) {
    console.error('Player API error:', err.message);
    return res.status(500).json({ error: 'Internal server error while fetching player data' });
  }
};
