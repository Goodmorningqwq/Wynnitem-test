module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uuid = typeof req.query.uuid === 'string' ? req.query.uuid.trim() : '';
  if (!uuid) {
    return res.status(400).json({ error: 'uuid required' });
  }

  const looksLikeUuid = /^[0-9a-fA-F-]{32,36}$/.test(uuid);
  if (!looksLikeUuid) {
    return res.status(400).json({ error: 'invalid uuid format' });
  }

  try {
    const response = await fetch(`https://api.wynncraft.com/v3/player/${encodeURIComponent(uuid)}`, {
      headers: {
        Accept: 'application/json'
      }
    }).catch(() => null);

    if (!response) {
      return res.status(503).json({ error: 'Upstream unavailable' });
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const status = Number(response.status || 502);
      return res.status(status).json({ error: data?.error || `API Error: ${status}` });
    }

    return res.json({
      uuid: data?.uuid || uuid,
      username: data?.username || null,
      wars: Number(data?.globalData?.wars || 0)
    });
  } catch (e) {
    console.error('Player wars API error:', e.message);
    return res.status(503).json({ error: 'Upstream fetch failed' });
  }
};
