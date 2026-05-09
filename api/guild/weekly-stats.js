/**
 * GET /api/guild/weekly-stats?guild=<guildName>
 *
 * Returns weekly performance stats for all guild members.
 *
 * Scoring algorithm (for overall Star ranking):
 *   totalScore = raids * 3 + wars * 2 + (xpContributed / 100_000)
 *
 * The weights reflect raid difficulty > war activity > passive XP contribution.
 *
 * Expected response shape:
 * {
 *   weekStart: string,           // ISO date of nearest Monday
 *   topRaids: PlayerStat[],      // top 3 by raids
 *   topWars:  PlayerStat[],      // top 3 by wars
 *   topXP:    PlayerStat[],      // top 3 by XP contributed
 *   fullList: FullPlayerStat[],  // all members, sorted by totalScore desc
 * }
 */

const WYNNCRAFT_GUILD_API = 'https://api.wynncraft.com/v3/guild';

/**
 * Returns the ISO date string (YYYY-MM-DD) of the most recent Monday.
 * @returns {string}
 */
function getWeekStartDate() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, …
  const diff = (day === 0 ? -6 : 1 - day); // distance back to Monday
  const monday = new Date(now);
  monday.setDate(now.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}

/**
 * Fetch raw guild data from Wynncraft v3 API by name.
 * @param {string} guildName
 * @returns {Promise<object>}
 */
async function fetchGuildData(guildName) {
  const url = `${WYNNCRAFT_GUILD_API}/${encodeURIComponent(guildName)}?identifier=uuid`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) {
    const err = new Error(`Wynncraft API error: ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

/**
 * Flatten all rank buckets into a unified member list.
 * @param {object} guildData
 * @returns {Array<object>}
 */
function collectMembers(guildData) {
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

      // Composite score: raids are weighted highest (hardest), wars next, XP as bonus
      const totalScore = raids * 3 + wars * 2 + xpContributed / 100_000;

      members.push({
        username: m.username || m.legacyName || memberKey || 'Unknown',
        raids,
        wars,
        xpContributed,
        totalScore: Math.round(totalScore * 100) / 100
      });
    }
  }

  return members;
}

/**
 * Build a top-3 leaderboard for a given numeric key.
 * @param {Array<object>} members
 * @param {string} key
 * @returns {Array<{username: string, value: number}>}
 */
function buildTop3(members, key) {
  return members
    .map((m) => ({ username: m.username, value: Number(m[key] || 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
}

module.exports = async (req, res) => {
  const rawGuild = req.query.guild || req.query.query;
  const guildName = typeof rawGuild === 'string' ? rawGuild.trim() : '';

  if (!guildName) {
    return res.status(400).json({ error: 'guild parameter is required' });
  }

  try {
    const guildData = await fetchGuildData(guildName);
    const members = collectMembers(guildData);

    if (!members.length) {
      return res.status(404).json({ error: 'Guild has no members' });
    }

    // Sort full list by composite score, highest first
    const fullList = members.slice().sort((a, b) => b.totalScore - a.totalScore);

    const payload = {
      weekStart: getWeekStartDate(),
      guildName: guildData.name || guildName,
      topRaids: buildTop3(members, 'raids'),
      topWars: buildTop3(members, 'wars'),
      topXP: buildTop3(members, 'xpContributed'),
      fullList
    };

    // Cache for 5 minutes at the edge — weekly stats don't need to be real-time
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.json(payload);
  } catch (e) {
    console.error('weekly-stats error:', e.message);
    if (e.status === 429) return res.status(429).json({ error: 'Rate limit exceeded' });
    if (e.status === 404) return res.status(404).json({ error: 'Guild not found' });
    return res.status(500).json({ error: 'Failed to load weekly stats' });
  }
};
