module.exports = async (req, res) => {
  const uuid = typeof req.query.uuid === 'string' ? req.query.uuid.trim() : '';
  if (!uuid) {
    return res.status(400).json({ error: 'uuid required' });
  }

  try {
    const response = await fetch(`https://api.wynncraft.com/v3/player/${encodeURIComponent(uuid)}`, {
      headers: {
        Accept: 'application/json'
      }
    });

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: `API Error: ${response.status}` });
    }

    return res.json({
      uuid: data?.uuid || uuid,
      username: data?.username || null,
      wars: Number(data?.globalData?.wars || 0)
    });
  } catch (e) {
    console.error('Player wars API error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
