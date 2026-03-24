const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD
});

function getEventKey(code) {
  return `guild:event:code:${String(code || '').toUpperCase()}`;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const code = typeof req.query.code === 'string' ? req.query.code.trim().toUpperCase() : '';
    const username = typeof req.query.username === 'string' ? req.query.username.trim() : '';
    if (!code) return res.status(400).json({ error: 'Event code required' });
    try {
      const eventStr = await redis.get(getEventKey(code));
      const event = typeof eventStr === 'string' ? JSON.parse(eventStr) : eventStr;
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (!event.isPublic && (!username || username !== event.owner)) {
        return res.status(403).json({ error: 'This event is private' });
      }
      return res.json(event);
    } catch (e) {
      console.error('Guild event GET error:', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    const { action, code, username, isPublic, event } = req.body || {};
    const normalizedCode = typeof code === 'string' ? code.trim().toUpperCase() : '';
    const normalizedUser = typeof username === 'string' ? username.trim() : '';
    if (!normalizedCode || !normalizedUser) {
      return res.status(400).json({ error: 'code and username are required' });
    }

    try {
      const key = getEventKey(normalizedCode);
      const existingStr = await redis.get(key);
      const existing = typeof existingStr === 'string' ? JSON.parse(existingStr) : existingStr;

      if (action === 'remove') {
        if (!existing) return res.json({ success: true });
        if (existing.owner !== normalizedUser) return res.status(403).json({ error: 'Only owner can remove event' });
        await redis.del(key);
        return res.json({ success: true });
      }

      if (action === 'visibility') {
        if (!existing) return res.status(404).json({ error: 'Event not found' });
        if (existing.owner !== normalizedUser) return res.status(403).json({ error: 'Only owner can update visibility' });
        existing.isPublic = Boolean(isPublic);
        existing.updatedAt = Date.now();
        await redis.set(key, JSON.stringify(existing));
        return res.json({ success: true, event: existing });
      }

      if (action === 'upsert') {
        if (!event || typeof event !== 'object') return res.status(400).json({ error: 'event payload required' });
        if (existing && existing.owner !== normalizedUser) return res.status(409).json({ error: 'Event code already in use' });
        const record = {
          eventCode: normalizedCode,
          owner: normalizedUser,
          isPublic: Boolean(event.isPublic),
          guildName: event.guildName || null,
          metric: event.metric || 'xp',
          scope: event.scope || 'selected',
          trackedPlayers: Array.isArray(event.trackedPlayers) ? event.trackedPlayers : [],
          startedAt: Number(event.startedAt || Date.now()),
          refreshCooldownMs: Number(event.refreshCooldownMs || 15 * 60 * 1000),
          baseline: event.baseline || { metricValue: 0, playerValues: {} },
          current: event.current || event.baseline || { metricValue: 0, playerValues: {} },
          lastRefreshAt: Number(event.lastRefreshAt || Date.now()),
          firstRefreshDone: Boolean(event.firstRefreshDone),
          updatedAt: Date.now()
        };
        await redis.set(key, JSON.stringify(record));
        return res.json({ success: true, event: record });
      }

      return res.status(400).json({ error: 'Invalid action' });
    } catch (e) {
      console.error('Guild event POST error:', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
