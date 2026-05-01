let cachedGuildList = null;
let cachedGuildListTime = 0;

async function getGuildList(forceFresh = false) {
  if (!forceFresh && cachedGuildList && Date.now() - cachedGuildListTime < 5 * 60 * 1000) {
    return cachedGuildList;
  }
  const listRes = await fetch('https://api.wynncraft.com/v3/guild/list/guild', {
    cache: 'no-store'
  });
  if (listRes.ok) {
    try {
      cachedGuildList = await listRes.json();
      cachedGuildListTime = Date.now();
    } catch {
      // Ignored
    }
  }
  return cachedGuildList;
}

async function fetchGuildName(name, forceFresh = false) {
  const url = `https://api.wynncraft.com/v3/guild/${encodeURIComponent(name)}?identifier=uuid`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    },
    cache: forceFresh ? 'no-store' : 'default'
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data, url };
}

async function fetchGuildUuid(uuid, forceFresh = false) {
  const url = `https://api.wynncraft.com/v3/guild/uuid/${encodeURIComponent(uuid)}?identifier=uuid`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json'
    },
    cache: forceFresh ? 'no-store' : 'default'
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  return { response, data, url };
}

async function fetchGuildPrefix(prefix, forceFresh = false) {
  const listData = await getGuildList(forceFresh);
  if (!listData) {
    // Fallback to legacy prefix endpoint if list fails entirely
    const url = `https://api.wynncraft.com/v3/guild/prefix/${encodeURIComponent(prefix)}?identifier=uuid`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: forceFresh ? 'no-store' : 'default'
    });
    let data;
    try { data = await response.json(); } catch { data = null; }
    return { response, data, url };
  }

  const targetLower = String(prefix).trim().toLowerCase();
  const matches = [];
  for (const [name, info] of Object.entries(listData)) {
    if (info.prefix && String(info.prefix).toLowerCase() === targetLower) {
      matches.push({ name, prefix: info.prefix });
    }
  }

  if (matches.length === 0) {
    return { response: { ok: false, status: 404 }, data: null };
  }

  if (matches.length === 1) {
    return await fetchGuildName(matches[0].name, forceFresh);
  }

  // Disambiguate multiple matches
  const options = {};
  for (const match of matches) {
    const sourceInfo = listData[match.name] || {};
    options[match.name] = {
      name: match.name,
      prefix: match.prefix,
      uuid: sourceInfo.uuid || sourceInfo.id || ''
    };
  }
  return { response: { ok: false, status: 300 }, data: options };
}

async function fetchGuildSuggestions(query, limit = 8, forceFresh = false) {
  const listData = await getGuildList(forceFresh);
  if (!listData || typeof listData !== 'object') {
    return [];
  }

  const target = String(query || '').trim().toLowerCase();
  if (!target) return [];

  const suggestions = [];
  for (const [name, info] of Object.entries(listData)) {
    const guildName = String(name || '').trim();
    const prefix = String(info?.prefix || '').trim();
    const uuid = String(info?.uuid || info?.id || '').trim();
    if (!guildName && !prefix) continue;

    const nameLower = guildName.toLowerCase();
    const prefixLower = prefix.toLowerCase();

    let score = 0;
    if (prefixLower === target) score = 140;
    else if (nameLower === target) score = 135;
    else if (prefixLower.startsWith(target)) score = 125;
    else if (nameLower.startsWith(target)) score = 115;
    else if (prefixLower.includes(target)) score = 95;
    else if (nameLower.includes(target)) score = 85;

    if (!score) continue;

    suggestions.push({
      name: guildName || prefix,
      prefix,
      uuid,
      score
    });
  }

  suggestions.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if ((a.name || '').length !== (b.name || '').length) return (a.name || '').length - (b.name || '').length;
    return (a.name || '').localeCompare(b.name || '');
  });

  return suggestions.slice(0, Math.max(1, Number(limit) || 8)).map(({ score, ...entry }) => entry);
}

function looksLikeUuid(str) {
  // Standard UUID: 8-4-4-4-12 hex digits, optionally without dashes (32 chars)
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim())
    || /^[0-9a-f]{32}$/i.test(str.trim());
}

function isNotFoundLike(response, data) {
  if (response.status === 404) return true;
  const detail = typeof data?.detail === 'string' ? data.detail.toLowerCase() : '';
  return response.status === 500 && detail.includes('unable to render this guild');
}

function applyCacheHeaders(res, forceFresh = false) {
  if (forceFresh) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return;
  }
  // Edge caching: 60s max age
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate');
}

module.exports = async (req, res) => {
  const rawQuery = req.query.query || req.query.name;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const mode = (req.query.mode || 'auto').toLowerCase();
  const forceFresh = req.query.fresh === '1' || req.query.fresh === 'true';

  if (!query) {
    return res.status(400).json({ error: 'Guild query required' });
  }

  if (!['auto', 'name', 'prefix', 'uuid', 'suggest'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid search mode' });
  }

  try {
    if (mode === 'uuid') {
      const { response, data } = await fetchGuildUuid(query, forceFresh);
      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        if (isNotFoundLike(response, data)) {
          return res.status(404).json({ error: 'Guild not found' });
        }
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      applyCacheHeaders(res, forceFresh);
      return res.json({ ...data, searchType: 'uuid' });
    }

    if (mode === 'name') {
      const { response, data } = await fetchGuildName(query, forceFresh);
      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        if (isNotFoundLike(response, data)) {
          return res.status(404).json({ error: 'Guild not found' });
        }
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      applyCacheHeaders(res, forceFresh);
      return res.json({ ...data, searchType: 'name' });
    }

    if (mode === 'prefix') {
      const { response, data } = await fetchGuildPrefix(query, forceFresh);
      if (!response.ok) {
        if (response.status === 429) {
          return res.status(429).json({ error: 'Rate limit exceeded' });
        }
        if (isNotFoundLike(response, data)) {
          return res.status(404).json({ error: 'Guild not found' });
        }
        if (response.status === 300) {
          applyCacheHeaders(res, forceFresh);
          return res.status(300).json({
            error: 'Ambiguous guild query',
            ambiguous: true,
            searchType: 'prefix',
            options: data || {}
          });
        }
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      applyCacheHeaders(res, forceFresh);
      return res.json({ ...data, searchType: 'prefix' });
    }

    if (mode === 'suggest') {
      const suggestions = await fetchGuildSuggestions(query, 8, forceFresh);
      applyCacheHeaders(res, forceFresh);
      return res.json({
        searchType: 'suggest',
        suggestions
      });
    }

    // Auto mode: detect UUID format first
    if (looksLikeUuid(query)) {
      const { response, data } = await fetchGuildUuid(query, forceFresh);
      if (response.ok) {
        applyCacheHeaders(res, forceFresh);
        return res.json({ ...(data || {}), searchType: 'uuid' });
      }
      if (response.status === 429) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
      // Fall through to name lookup if UUID attempt fails
    }

    const nameResult = await fetchGuildName(query, forceFresh);
    if (nameResult.response.ok) {
      applyCacheHeaders(res, forceFresh);
      return res.json({ ...(nameResult.data || {}), searchType: 'name' });
    }

    // Short circuit if we hit a rate limit on the first try
    if (nameResult.response.status === 429) {
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }

    const prefixResult = await fetchGuildPrefix(query, forceFresh);
    if (prefixResult.response.ok) {
      applyCacheHeaders(res, forceFresh);
      return res.json({ ...(prefixResult.data || {}), searchType: 'prefix' });
    }

    if (prefixResult.response.status === 300) {
      applyCacheHeaders(res, forceFresh);
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

    // Return the highest priority status (like 429 over 404)
    const upstreamStatus = prefixResult.response.status === 429 ? 429 : (prefixResult.response.status || nameResult.response.status || 500);
    return res.status(upstreamStatus).json({ error: `API Error: ${upstreamStatus}` });
  } catch (e) {
    console.error('Guild API error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
