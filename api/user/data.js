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

  if (!username) {
    return res.status(400).json({ error: 'Username required' });
  }

  if (req.method === 'GET') {
    try {
      const dataKey = `user:${username}:data`;
      const eventsKey = `user:${username}:events`;

      const userDataStr = await redis.get(dataKey);
      const events = await redis.lrange(eventsKey, 0, 49);

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

      const dataKey = `user:${username}:data`;
      const eventsKey = `user:${username}:events`;

      const userDataStr = await redis.get(dataKey);
      const userData = parseJsonSafe(userDataStr, getDefaultUserData());

      if (guildName !== undefined) {
        if (guildName !== userData.guildName && userData.trackedPlayers.length > 0) {
          return res.status(400).json({ error: 'You can only track players from one guild. Clear current players first.' });
        }
        userData.guildName = guildName;
      }

      if (trackedPlayers !== undefined) {
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
        userData.activeEvent = activeEvent;
      }

      await redis.set(dataKey, JSON.stringify(userData));

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

  return res.status(405).json({ error: 'Method not allowed' });
};