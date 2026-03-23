module.exports = async (req, res) => {
  const guildName = req.query.name;

  console.log('[DEBUG] guildName:', guildName);

  if (!guildName) {
    return res.status(400).json({ error: 'Guild name required' });
  }

  try {
    const url = `https://api.wynncraft.com/v3/guild/${encodeURIComponent(guildName)}?identifier=uuid`;
    console.log('[DEBUG] Fetching:', url);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json'
      }
    });

    console.log('[DEBUG] Response status:', response.status);

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({ error: 'Guild not found' });
      }
      return res.status(response.status).json({ error: `API Error: ${response.status}` });
    }

    const data = await response.json();
    console.log('[DEBUG] Guild data received:', data.name);
    return res.json(data);
  } catch (e) {
    console.error('[DEBUG] Guild API error:', e.message, e.stack);
    return res.status(500).json({ error: e.message });
  }
};
