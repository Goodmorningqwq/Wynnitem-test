const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD,
});

function getDefaultUserData() {
  return {
    guildName: null,
    trackedPlayers: [],
    activeEvent: null
  };
}

function sanitizeActiveEvent(value) {
  if (!value || typeof value !== 'object') return null;
  const metric = value.metric === 'wars' ? 'wars' : 'xp';
  const scope = value.scope === 'guild' ? 'guild' : 'selected';
  const trackedPlayers = Array.isArray(value.trackedPlayers)
    ? value.trackedPlayers.filter((p) => typeof p === 'string').slice(0, 100)
    : [];
  const refreshCooldownMs = Number(value.refreshCooldownMs || 15 * 60 * 1000);
  const startedAt = Number(value.startedAt || Date.now());
  const lastRefreshAt = Number(value.lastRefreshAt || startedAt);
  const firstRefreshDone = Boolean(value.firstRefreshDone);
  const eventCode = typeof value.eventCode === 'string' ? value.eventCode.trim().toUpperCase() : null;
  const isPublic = Boolean(value.isPublic);
  const baseline = value.baseline && typeof value.baseline === 'object' ? value.baseline : null;
  const current = value.current && typeof value.current === 'object' ? value.current : baseline;

  return {
    guildName: typeof value.guildName === 'string' ? value.guildName : null,
    metric,
    scope,
    trackedPlayers,
    refreshCooldownMs,
    startedAt,
    lastRefreshAt,
    firstRefreshDone,
    eventCode,
    isPublic,
    baseline,
    current
  };
}

function parseJsonSafe(value, fallback) {
  if (!value) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

module.exports = async (req, res) => {
  const username = req.query.username;
  const usernameTrimmed = typeof username === 'string' ? username.trim() : '';
  const usernameLower = usernameTrimmed.toLowerCase();
  const candidateUsernames = Array.from(new Set(
    [username, usernameTrimmed, usernameLower].filter((value) => typeof value === 'string' && value.length > 0)
  ));
  const dataKey = `user:${username}:data`;
  const eventsKey = `user:${username}:events`;

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  if (req.method === 'GET') {
    try {
      const includeEvents = req.query.includeEvents === 'true';

      const userDataStr = await redis.get(dataKey);
      const events = includeEvents ? await redis.lrange(eventsKey, 0, 49) : [];

      const userData = parseJsonSafe(userDataStr, getDefaultUserData());
      const parsedEvents = events
        .map(e => parseJsonSafe(e, null))
        .filter(Boolean)
        .reverse();

      return res.json({
        username: username,
        guildName: userData.guildName,
        trackedPlayers: userData.trackedPlayers || [],
        activeEvent: userData.activeEvent,
        events: parsedEvents || []
      });
    } catch (e) {
      console.error('Get data error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { guildName, trackedPlayers, activeEvent, addEvent, addPlayer, removePlayer, clearPlayers } = req.body;

      const userDataStr = await redis.get(dataKey);
      const userData = parseJsonSafe(userDataStr, getDefaultUserData());
      const beforeJson = JSON.stringify(userData);

      if (guildName !== undefined) {
        if (guildName !== userData.guildName && userData.trackedPlayers.length > 0) {
          return res.status(400).json({ error: 'You can only track players from one guild. Clear current players first.' });
        }
        userData.guildName = guildName;
      }

      if (trackedPlayers !== undefined) {
        if (!Array.isArray(trackedPlayers)) {
          return res.status(400).json({ error: 'trackedPlayers must be an array' });
        }
        if (trackedPlayers.length > 0 && userData.guildName && trackedPlayers[0]) {
          const currentGuild = userData.guildName;
          userData.trackedPlayers = trackedPlayers;
        } else {
          userData.trackedPlayers = trackedPlayers;
        }
      }

      if (addPlayer !== undefined) {
        if (userData.trackedPlayers.length >= 20) {
          return res.status(400).json({ error: 'Maximum 20 players allowed per user' });
        }
        if (!userData.trackedPlayers.includes(addPlayer)) {
          userData.trackedPlayers.push(addPlayer);
        }
      }

      if (removePlayer !== undefined) {
        userData.trackedPlayers = userData.trackedPlayers.filter(p => p !== removePlayer);
      }

      if (clearPlayers !== undefined) {
        userData.trackedPlayers = [];
        userData.activeEvent = null;
      }

      if (activeEvent !== undefined) {
        const sanitizedEvent = sanitizeActiveEvent(activeEvent);
        if (sanitizedEvent && userData.guildName && sanitizedEvent.guildName && sanitizedEvent.guildName !== userData.guildName) {
          return res.status(400).json({ error: 'Active event guild must match tracked guild' });
        }
        userData.activeEvent = sanitizedEvent;
      }

      const afterJson = JSON.stringify(userData);
      if (beforeJson !== afterJson) {
        await redis.set(dataKey, afterJson);
      }

      if (addEvent) {
        await redis.lpush(eventsKey, JSON.stringify(addEvent));
        await redis.ltrim(eventsKey, 0, 99);
      }

      return res.json({ success: true, trackedPlayers: userData.trackedPlayers });
    } catch (e) {
      console.error('Update data error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const keysToDelete = [];
      for (const candidate of candidateUsernames) {
        keysToDelete.push(`user:${candidate}:data`);
        keysToDelete.push(`user:${candidate}:events`);
      }
      if (keysToDelete.length) {
        await redis.del(...keysToDelete);
      }
      return res.json({ success: true });
    } catch (e) {
      console.error('Delete data error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};