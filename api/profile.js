function buildPlayerUrl(player) {
  // Wynncraft expects presence-only fullResult flag (`?fullResult`).
  return `https://api.wynncraft.com/v3/player/${encodeURIComponent(player)}?fullResult`;
}

function pickBestMultiMatch(data, requestedPlayer) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const requestedLower = String(requestedPlayer || '').trim().toLowerCase();
  if (!requestedLower) return null;

  const entries = Object.entries(data);
  const exactName = entries.find(([, value]) => String(value?.storedName || '').trim().toLowerCase() === requestedLower);
  if (exactName) return exactName[0];

  // Fall back to a strict key match if upstream keys are usernames.
  const exactKey = entries.find(([key]) => String(key || '').trim().toLowerCase() === requestedLower);
  if (exactKey) return exactKey[0];

  return null;
}

module.exports = async (req, res) => {
  const player = req.query.player || req.query.uuid;
  const action = req.query.action;

  if (!player) {
    return res.status(400).json({ 
      error: 'Player name or UUID required', 
      debug: { url: req.url, query: req.query || {} } 
    });
  }

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
  const url = buildPlayerUrl(player);
  
  try {
    const upstreamRes = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Wynnitem-Tracker/1.0' }
    });

    const data = await upstreamRes.json().catch(() => null);

    // Username lookups can return 300 with multi-selector payloads.
    // Try to auto-resolve exact storedName/key match before returning ambiguity.
    if (upstreamRes.status === 300) {
      const selectedIdentifier = pickBestMultiMatch(data, player);
      if (selectedIdentifier) {
        const retryUrl = buildPlayerUrl(selectedIdentifier);
        const retryRes = await fetch(retryUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'Wynnitem-Tracker/1.0' }
        });
        const retryData = await retryRes.json().catch(() => null);
        if (!retryRes.ok) {
          if (retryRes.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
          return res.status(retryRes.status).json({ error: `API Error: ${retryRes.status}` });
        }
        res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
        return res.json(retryData);
      }
      return res.status(300).json({
        error: 'Multiple players matched query',
        ambiguous: true,
        options: data && typeof data === 'object' ? data : {}
      });
    }

    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
      return res.status(upstreamRes.status).json({ error: `API Error: ${upstreamRes.status}` });
    }

    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=600');
    return res.json(data);
  } catch (err) {
    console.error('Player profile error:', err.message);
    return res.status(500).json({ error: 'Internal server error while fetching player profile' });
  }
};
