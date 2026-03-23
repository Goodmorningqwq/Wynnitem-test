async function fetchGuild(target, mode) {
  const isPrefix = mode === 'prefix';
  const path = isPrefix ? `prefix/${encodeURIComponent(target)}` : encodeURIComponent(target);
  const url = `https://api.wynncraft.com/v3/guild/${path}?identifier=uuid`;
  const response = await fetch(url, {
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
  return { response, data, url };
}

function isNotFoundLike(response, data) {
  if (response.status === 404) return true;
  const detail = typeof data?.detail === 'string' ? data.detail.toLowerCase() : '';
  return response.status === 500 && detail.includes('unable to render this guild');
}

module.exports = async (req, res) => {
  const rawQuery = req.query.query || req.query.name;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const mode = (req.query.mode || 'auto').toLowerCase();

  if (!query) {
    return res.status(400).json({ error: 'Guild query required' });
  }

  if (!['auto', 'name', 'prefix'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid search mode' });
  }

  try {
    if (mode === 'name' || mode === 'prefix') {
      const { response, data } = await fetchGuild(query, mode);
      if (!response.ok) {
        if (isNotFoundLike(response, data)) {
          return res.status(404).json({ error: 'Guild not found' });
        }
        if (response.status === 300) {
          return res.status(300).json({
            error: 'Ambiguous guild query',
            ambiguous: true,
            searchType: mode,
            options: data || {}
          });
        }
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      return res.json({ ...data, searchType: mode });
    }

    const nameResult = await fetchGuild(query, 'name');
    if (nameResult.response.ok) {
      return res.json({ ...(nameResult.data || {}), searchType: 'name' });
    }
    if (nameResult.response.status === 300) {
      return res.status(300).json({
        error: 'Ambiguous guild query',
        ambiguous: true,
        searchType: 'name',
        options: nameResult.data || {}
      });
    }

    const prefixResult = await fetchGuild(query, 'prefix');
    if (prefixResult.response.ok) {
      return res.json({ ...(prefixResult.data || {}), searchType: 'prefix' });
    }
    if (prefixResult.response.status === 300) {
      return res.status(300).json({
        error: 'Ambiguous guild query',
        ambiguous: true,
        searchType: 'prefix',
        options: prefixResult.data || {}
      });
    }

    if (isNotFoundLike(nameResult.response, nameResult.data) && isNotFoundLike(prefixResult.response, prefixResult.data)) {
      return res.status(404).json({ error: 'Guild not found' });
    }

    const upstreamStatus = prefixResult.response.status || nameResult.response.status || 500;
    return res.status(upstreamStatus).json({ error: `API Error: ${upstreamStatus}` });
  } catch (e) {
    console.error('Guild API error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
