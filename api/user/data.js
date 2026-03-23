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
      // #region agent log
      fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0353be'},body:JSON.stringify({sessionId:'0353be',runId:'run1',hypothesisId:'H4',location:'api/user/data.js:POST:entry',message:'POST /api/user/data entry',data:{hasUsername:Boolean(username),hasGuildName:guildName!==undefined,hasTrackedPlayers:trackedPlayers!==undefined,trackedPlayersIsArray:Array.isArray(trackedPlayers),hasActiveEvent:activeEvent!==undefined,hasAddEvent:Boolean(addEvent),hasClearPlayers:clearPlayers!==undefined},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

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
        if (!Array.isArray(trackedPlayers)) {
          // #region agent log
          fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0353be'},body:JSON.stringify({sessionId:'0353be',runId:'run1',hypothesisId:'H3',location:'api/user/data.js:POST:trackedPlayersValidation',message:'Rejecting trackedPlayers type',data:{trackedPlayersType:typeof trackedPlayers},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
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
        if (sanitizedEvent && userData.activeEvent) {
          // #region agent log
          fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0353be'},body:JSON.stringify({sessionId:'0353be',runId:'run1',hypothesisId:'H1',location:'api/user/data.js:POST:activeEventValidation',message:'Rejecting due to existing active event',data:{incomingGuildName:sanitizedEvent.guildName,existingHasActiveEvent:Boolean(userData.activeEvent)},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          return res.status(400).json({ error: 'Only one active event is allowed' });
        }
        if (sanitizedEvent && userData.guildName && sanitizedEvent.guildName && sanitizedEvent.guildName !== userData.guildName) {
          // #region agent log
          fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0353be'},body:JSON.stringify({sessionId:'0353be',runId:'run1',hypothesisId:'H2',location:'api/user/data.js:POST:guildValidation',message:'Rejecting due to guild mismatch',data:{incomingGuildName:sanitizedEvent.guildName,currentGuildName:userData.guildName},timestamp:Date.now()})}).catch(()=>{});
          // #endregion
          return res.status(400).json({ error: 'Active event guild must match tracked guild' });
        }
        userData.activeEvent = sanitizedEvent;
      }

      await redis.set(dataKey, JSON.stringify(userData));

      if (addEvent) {
        await redis.lpush(eventsKey, JSON.stringify(addEvent));
        await redis.ltrim(eventsKey, 0, 99);
      }
      // #region agent log
      fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'0353be'},body:JSON.stringify({sessionId:'0353be',runId:'run1',hypothesisId:'H5',location:'api/user/data.js:POST:success',message:'POST /api/user/data success',data:{trackedPlayersCount:Array.isArray(userData.trackedPlayers)?userData.trackedPlayers.length:0,hasActiveEvent:Boolean(userData.activeEvent)},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      return res.json({ success: true, trackedPlayers: userData.trackedPlayers });
    } catch (e) {
      console.error('Update data error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};