const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

/**
 * Parse a JSON value from Redis safely.
 * @param {*} raw
 * @returns {object|null}
 */
function parseJsonSafe(raw) {
  if (!raw) return null;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// TTL for the weekly baseline in Redis: 8 days (covers the full week + 1-day grace)
const WEEKLY_BASELINE_TTL_SECS = 8 * 24 * 60 * 60;

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
 * Returns YYYY-MM-DD of the most recent Monday (week start, UTC).
 * @returns {string}
 */
function getWeekStartDate() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}

/** Redis key for a guild's weekly baseline snapshot. */
function weeklyBaselineKey(guildName) {
  return `guild:weekly-baseline:${String(guildName).toLowerCase().trim()}`;
}

/**
 * Load the stored weekly baseline for a guild from Redis.
 * Returns null if none exists.
 * @param {string} guildName
 * @returns {Promise<object|null>}
 */
async function loadWeeklyBaseline(guildName) {
  try {
    const raw = await redis.get(weeklyBaselineKey(guildName));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (e) {
    console.error('[weekly-stats] loadWeeklyBaseline error:', e.message);
    return null;
  }
}

/**
 * Save the current member stats as the new weekly baseline.
 * @param {string} guildName
 * @param {Array<object>} members  Output of collectWeeklyMembers()
 * @param {string} weekStart  YYYY-MM-DD
 */
async function saveWeeklyBaseline(guildName, members, weekStart) {
  const snapshot = {
    weekStart,
    savedAt: new Date().toISOString(),
    members: {} // keyed by lowercase username for fast lookup
  };
  for (const m of members) {
    snapshot.members[m.username.toLowerCase()] = {
      raids: m.raids,
      wars: m.wars,
      xpContributed: m.xpContributed
    };
  }
  await redis.set(weeklyBaselineKey(guildName), JSON.stringify(snapshot), {
    ex: WEEKLY_BASELINE_TTL_SECS
  });
  return snapshot;
}

/**
 * Flatten all rank buckets into a stats member list (raw lifetime totals).
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
      const username = m.username || m.legacyName || memberKey || 'Unknown';

      // Detect API data quality issues that corrupt the baseline snapshot.
      // When guildRaids is absent entirely, we fall back to globalData.raids.total
      // which may differ from guildRaids in future calls → wrong weekly delta.
      const guildRaidsField = m.globalData?.guildRaids ?? m.guildRaids;
      if (guildRaidsField === undefined || guildRaidsField === null) {
        console.warn(
          `[collectWeeklyMembers] WARNING: guildRaids field ABSENT for "${username}" (rank: ${rank}).` +
          ` Falling back to globalData.raids.total=${m.globalData?.raids?.total ?? 0}.` +
          ' Baseline may be inaccurate for this member — check Wynncraft API response.'
        );
      } else if ((guildRaidsField.total ?? 0) === 0 && (m.globalData?.raids?.total ?? 0) > 0) {
        console.info(
          `[collectWeeklyMembers] INFO: guildRaids.total=0 but raids.total=${m.globalData.raids.total} for "${username}".` +
          ' Member may be new to the guild or API data not yet synced.'
        );
      }

      const raids = Number(
        m.globalData?.guildRaids?.total
        ?? m.guildRaids?.total
        ?? m.globalData?.raids?.total
        ?? 0
      );
      const wars = Number(m.globalData?.wars ?? 0);
      const xpContributed = Number(m.contributed ?? 0);
      members.push({
        username,
        raids,
        wars,
        xpContributed
      });
    }
  }
  return members;
}

/**
 * Apply a stored baseline snapshot to compute weekly deltas.
 * Members not in the baseline get their full totals as the delta (new members this week).
 * @param {Array<object>} members  Live member list
 * @param {object|null} baseline   Stored snapshot (or null = first week, use full totals)
 * @returns {Array<object>}  Members with delta fields + totalScore
 */
function applyBaseline(members, baseline) {
  return members.map((m) => {
    let base = null;
    if (baseline?.members) {
      base = baseline.members[m.username.toLowerCase()] || null;
    }
    // If no baseline exists yet, weekly delta = full lifetime total
    const deltaRaids = base ? Math.max(0, m.raids - (base.raids || 0)) : m.raids;
    const deltaWars  = base ? Math.max(0, m.wars  - (base.wars  || 0)) : m.wars;
    const deltaXP    = base ? Math.max(0, m.xpContributed - (base.xpContributed || 0)) : m.xpContributed;
    // Scoring: raids*3 + wars*2 + XP/100_000
    const totalScore = Math.round((deltaRaids * 3 + deltaWars * 2 + deltaXP / 100000) * 100) / 100;
    return {
      username: m.username,
      raids:   deltaRaids,
      wars:    deltaWars,
      xpContributed: deltaXP,
      totalScore
    };
  });
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

  // Cron path: /api/guild/weekly-reset hits this handler with x-vercel-cron header
  // We need a guild name to snapshot. When triggered by cron (no query), it checks
  // the well-known cron guild list stored in env or skips gracefully.
  const isCronRequest = req.headers['x-vercel-cron'] === '1';
  const isWeeklyResetPath = (req.url || '').includes('weekly-reset') || mode === 'weekly-reset';
  if (isCronRequest && isWeeklyResetPath) {
    // Cron resets all guilds stored in WEEKLY_RESET_GUILDS env var (comma-separated)
    const guildList = String(process.env.WEEKLY_RESET_GUILDS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!guildList.length) {
      return res.status(200).json({ success: true, note: 'No guilds configured in WEEKLY_RESET_GUILDS' });
    }
    const weekStart = getWeekStartDate();
    const results = [];
    for (const guildName of guildList) {
      try {
        const { response, data } = await fetchGuildName(guildName, true);
        if (!response.ok) { results.push({ guild: guildName, ok: false, error: response.status }); continue; }
        const liveMembers = collectWeeklyMembers(data);
        await saveWeeklyBaseline(data.name || guildName, liveMembers, weekStart);
        results.push({ guild: data.name || guildName, ok: true, members: liveMembers.length });
      } catch (e) {
        results.push({ guild: guildName, ok: false, error: e.message });
      }
    }
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true, weekStart, results });
  }

  if (!query) {
    return res.status(400).json({ error: 'Guild query required' });
  }

  if (!['auto', 'name', 'prefix', 'uuid', 'suggest', 'members', 'weekly-stats', 'weekly-reset'].includes(mode)) {
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
      const { response, data } = await fetchGuildName(query, true); // always fresh for live deltas
      if (!response.ok) {
        if (response.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
        if (isNotFoundLike(response, data)) return res.status(404).json({ error: 'Guild not found' });
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      const guildName = data.name || query;
      const liveMembers = collectWeeklyMembers(data);
      if (!liveMembers.length) return res.status(404).json({ error: 'Guild has no members' });

      const baseline = await loadWeeklyBaseline(guildName);
      const weekStart = baseline?.weekStart || getWeekStartDate();
      const deltaMembers = applyBaseline(liveMembers, baseline);
      const fullList = deltaMembers.slice().sort((a, b) => b.totalScore - a.totalScore);

      // When forceFresh is set (e.g. right after a manual reset) bypass the CDN cache
      // so the client immediately sees the new 0-delta baseline instead of stale data.
      if (forceFresh) {
        res.setHeader('Cache-Control', 'no-store, max-age=0');
      } else {
        res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');
      }
      return res.json({
        weekStart,
        guildName,
        hasBaseline: Boolean(baseline),
        topRaids: buildTop3(deltaMembers, 'raids'),
        topWars:  buildTop3(deltaMembers, 'wars'),
        topXP:    buildTop3(deltaMembers, 'xpContributed'),
        fullList
      });
    }

    // weekly-reset: save current stats as the new baseline (called by cron, admin token, or guild account owner)
    if (mode === 'weekly-reset') {
      const isCron = req.headers['x-vercel-cron'] === '1';
      const adminToken = String(req.headers['x-cache-admin-token'] || req.query.token || '');
      const expectedToken = String(process.env.CACHE_ADMIN_TOKEN || '');
      const isAdmin = Boolean(expectedToken) && adminToken === expectedToken;

      // Guild account owners may trigger a manual reset for their own guild.
      // Verify: redis key guild:<username>:data exists and its guildName matches query (case-insensitive).
      let isGuildOwner = false;
      const callerUsername = String(req.query.username || req.headers['x-caller-username'] || '').trim().toLowerCase();
      if (!isCron && !isAdmin && callerUsername) {
        try {
          const guildDataRaw = await redis.get(`guild:${callerUsername}:data`);
          const guildData = parseJsonSafe(guildDataRaw);
          if (
            guildData &&
            guildData.isGuildAccount === true &&
            typeof guildData.guildName === 'string' &&
            guildData.guildName.toLowerCase() === query.toLowerCase()
          ) {
            isGuildOwner = true;
          }
        } catch (e) {
          console.error('[weekly-reset] guild owner check failed:', e.message);
        }
      }

      if (!isCron && !isAdmin && !isGuildOwner) {
        return res.status(403).json({ error: 'Forbidden - requires cron header, admin token, or guild account' });
      }
      const { response, data } = await fetchGuildName(query, true);
      if (!response.ok) {
        if (response.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
        if (isNotFoundLike(response, data)) return res.status(404).json({ error: 'Guild not found' });
        return res.status(response.status).json({ error: `API Error: ${response.status}` });
      }
      const guildName = data.name || query;
      const liveMembers = collectWeeklyMembers(data);
      const weekStart = getWeekStartDate();
      const savedAt = new Date().toISOString();
      await saveWeeklyBaseline(guildName, liveMembers, weekStart);
      res.setHeader('Cache-Control', 'no-store');
      return res.json({ success: true, guildName, weekStart, savedAt, memberCount: liveMembers.length });
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
