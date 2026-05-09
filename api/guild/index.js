

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

function extractMembers(guildData) {
  if (!guildData || !guildData.members) return [];
  const rankOrder = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const members = [];
  const ranks = guildData.members;
  for (const rank of rankOrder) {
    const rankMembers = ranks[rank];
    if (!rankMembers || typeof rankMembers !== 'object') continue;
    const displayRank = rank.charAt(0).toUpperCase() + rank.slice(1).toLowerCase();
    if (Array.isArray(rankMembers)) {
      for (const m of rankMembers) {
        if (!m) continue;
        members.push({
          username: m.username || m.legacyName || m.name || '',
          uuid: m.uuid || m.id || '',
          rank: displayRank,
          online: Boolean(m.online),
          contributed: Number(m.contributed || 0),
          joined: m.joined || ''
        });
      }
    } else {
      for (const [memberKey, m] of Object.entries(rankMembers)) {
        if (!m) continue;
        members.push({
          username: m.username || m.legacyName || memberKey || '',
          uuid: m.uuid || m.id || '',
          rank: displayRank,
          online: Boolean(m.online),
          contributed: Number(m.contributed || 0),
          joined: m.joined || ''
        });
      }
    }
  }
  return members;
}

// ── Weekly Stats helpers (mode=weekly-stats) ──────────────────────────────

/**
 * Returns YYYY-MM-DD of the most recent Monday (week start).
 * @returns {string}
 */
function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

/**
 * Flatten all rank buckets into a stats member list.
 * Scoring: raids*3 + wars*2 + xpContributed/100_000
 * @param {object} guildData
 * @returns {Array<object>}
 */
function collectWeeklyMembers(guildData) {
  if (!guildData?.members) return [];
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const members = [];
  for (const rank of ranks) {
    const bucket = guildData.members[rank];
    if (!bucket || typeof bucket !== 'object') continue;
    const entries = Array.isArray(bucket)
      ? bucket.map((m) => [m?.username || '', m])
      : Object.entries(bucket);
    for (const [memberKey, m] of entries) {
      if (!m) continue;
      const raids = Number(
        m.globalData?.guildRaids?.total
        ?? m.guildRaids?.total
        ?? m.globalData?.raids?.total
        ?? 0
      );
      const wars = Number(m.globalData?.wars ?? 0);
      const xpContributed = Number(m.contributed ?? 0);
      const totalScore = Math.round((raids * 3 + wars * 2 + xpContributed / 100000) * 100) / 100;
      members.push({
        username: m.username || m.legacyName || memberKey || 'Unknown',
        raids,
        wars,
        xpContributed,
        totalScore
      });
    }
  }
  return members;
}

/**
 * Build a top-3 array sorted by a numeric key.
 * @param {Array<object>} members
 * @param {string} key
 * @returns {Array<{username:string, value:number}>}
 */
function buildTop3(members, key) {
  return members
    .map((m) => ({ username: m.username, value: Number(m[key] || 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
}

module.exports = async (req, res) => {
  const rawQuery = req.query.query || req.query.name;
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  const mode = (req.query.mode || 'auto').toLowerCase();
  const forceFresh = req.query.fresh === '1' || req.query.fresh === 'true';

  if (!query) {
    return res.status(400).json({ error: 'Guild query required' });
  }

  if (!['auto', 'name', 'prefix', 'uuid', 'suggest', 'members', 'weekly-stats'].includes(mode)) {
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

    if (mode === 'members') {
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

      // Extract the member list from guild data and return it.
      // lastJoin lookups are handled client-side via /api/profile to avoid server DB usage.
      const members = extractMembers(data);

      // Sort: online first, then by username alphabetically for a stable initial order.
      members.sort((a, b) => {
        if (a.online !== b.online) return b.online ? 1 : -1;
        return (a.username || '').localeCompare(b.username || '');
      });

      res.setHeader('Cache-Control', 'no-store');
      return res.json({
        guildName: data.name || query,
        prefix: data.prefix || '',
        members,
        searchType: 'members'
      });
    }

    if (mode === 'weekly-stats') {
      const { response, data } = await fetchGuildName(query, forceFresh);
      if (!response.ok) {
        if (response.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
        if (isNotFoundLike(response, data)) return res.status(404).json({ error: 'Guild not found' });
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      const members = collectWeeklyMembers(data);
      if (!members.length) return res.status(404).json({ error: 'Guild has no members' });
      const fullList = members.slice().sort((a, b) => b.totalScore - a.totalScore);
      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
      return res.json({
        weekStart: getWeekStartDate(),
        guildName: data.name || query,
        topRaids: buildTop3(members, 'raids'),
        topWars:  buildTop3(members, 'wars'),
        topXP:    buildTop3(members, 'xpContributed'),
        fullList
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
