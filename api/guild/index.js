const fetch = (...args) => import('node-fetch').then(module => module.default(...args));

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

module.exports = async (req, res) => {
  const guildName = req.query.name;

  if (!guildName) {
    return res.status(400).json({ error: 'Guild name required' });
  }

  try {
    const response = await fetch(`https://api.wynncraft.com/v3/guild/${encodeURIComponent(guildName)}?identifier=${generateUUID()}`, {
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({ error: 'Guild not found' });
      }
      return res.status(response.status).json({ error: `API Error: ${response.status}` });
    }

    const data = await response.json();
    return res.json(data);
  } catch (e) {
    console.error('Guild API error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
