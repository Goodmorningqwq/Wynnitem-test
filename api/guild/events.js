const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
  token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD
});

const WEBHOOK_KEY_PREFIX = 'guild:event:discord:webhook:';
const NOTIFY_STATE_KEY_PREFIX = 'guild:event:discord:notify:';

function getEventKey(code) {
  return `guild:event:code:${String(code || '').toUpperCase()}`;
}

function getWebhookKey(code) {
  return `${WEBHOOK_KEY_PREFIX}${String(code || '').toUpperCase()}`;
}

function getNotifyStateKey(code) {
  return `${NOTIFY_STATE_KEY_PREFIX}${String(code || '').toUpperCase()}`;
}

function parseJsonSafe(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isLikelyDiscordWebhookUrl(url) {
  const value = String(url || '').trim();
  return /^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(value);
}

function buildDigest(payload) {
  const data = JSON.stringify(payload || {});
  return crypto.createHash('sha256').update(data).digest('hex');
}

function buildEmbed({ event, kind, snapshot }) {
  const metricLabel = event.metric === 'wars' ? 'Wars' : event.metric === 'guildRaids' ? 'Guild Raids' : 'Guild XP';
  const scopeLabel = event.scope === 'guild' ? 'Entire Guild' : 'Selected Players';
  const baseline = Number(event.baseline?.metricValue || 0);
  const current = Number(snapshot?.metricValue ?? event.current?.metricValue ?? baseline);
  const delta = current - baseline;
  const baselinePlayers = event.baseline?.playerValues || {};
  const currentPlayers = snapshot?.playerValues || event.current?.playerValues || {};
  const allNames = Array.from(new Set([...Object.keys(baselinePlayers), ...Object.keys(currentPlayers)]));
  const top = allNames
    .map((name) => {
      const start = Number(baselinePlayers[name] || 0);
      const currentValue = Number(currentPlayers[name] || 0);
      return { name, value: currentValue - start };
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topText = top.length
    ? top.map((row, idx) => `#${idx + 1} ${row.name} - ${row.value >= 0 ? '+' : ''}${row.value.toLocaleString()}`).join('\n')
    : 'No player values';

  return {
    title: kind === 'end' ? 'Event Ended' : 'Leaderboard Refreshed',
    description: `${event.guildName || 'Unknown Guild'} - ${metricLabel} - ${scopeLabel}`,
    color: kind === 'end' ? 0xef4444 : 0x8b5cf6,
    fields: [
      { name: 'Event Code', value: event.eventCode || '-', inline: true },
      { name: 'Current', value: current.toLocaleString(), inline: true },
      { name: 'Delta', value: `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`, inline: true },
      { name: 'Top Players', value: topText, inline: false }
    ],
    footer: { text: kind === 'end' ? 'Final summary' : 'Dashboard refresh' },
    timestamp: new Date().toISOString()
  };
}

async function sendDiscordWebhook(webhookUrl, payload) {
  const url = String(webhookUrl || '').trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const retryMs = Number(body?.retry_after || 1) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.max(300, retryMs)));
    return sendDiscordWebhook(url, payload);
  }
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, status: response.status, error: text };
  }
  return { ok: true };
}

module.exports = async (req, res) => {
  const discordAction = String(req.query.discordAction || '').trim().toLowerCase();

  if (discordAction === 'webhook-link') {
    if (req.method === 'POST') {
      try {
        const eventCode = String(req.body?.eventCode || '').trim().toUpperCase();
        const webhookUrl = String(req.body?.webhookUrl || '').trim();
        const username = String(req.body?.username || '').trim();
        const linkedByDisplay = String(req.body?.linkedByDisplay || '').trim();
        if (!eventCode || !webhookUrl || !username) {
          return res.status(400).json({ error: 'eventCode, webhookUrl, and username are required' });
        }
        if (!isLikelyDiscordWebhookUrl(webhookUrl)) {
          return res.status(400).json({ error: 'Invalid Discord webhook URL' });
        }

        const eventStr = await redis.get(getEventKey(eventCode));
        const event = parseJsonSafe(eventStr, null);
        if (!event) return res.status(404).json({ error: 'Event code does not exist' });
        if (event.owner && username !== event.owner) {
          return res.status(403).json({ error: 'Only event owner can link webhook' });
        }

        const record = {
          webhookUrl,
          linkedBy: username,
          linkedByDisplay,
          linkedAt: Date.now()
        };
        await redis.set(getWebhookKey(eventCode), JSON.stringify(record));
        return res.json({ success: true, eventCode, linkedBy: username });
      } catch (e) {
        console.error('Discord webhook link POST error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }

    if (req.method === 'GET') {
      try {
        const eventCode = String(req.query.eventCode || '').trim().toUpperCase();
        const username = String(req.query.username || '').trim();
        if (!eventCode || !username) {
          return res.status(400).json({ error: 'eventCode and username are required' });
        }
        const eventStr = await redis.get(getEventKey(eventCode));
        const event = parseJsonSafe(eventStr, null);
        if (!event) return res.status(404).json({ error: 'Event not found' });
        if (event.owner && username !== event.owner) {
          return res.status(403).json({ error: 'Only event owner may view webhook link status' });
        }
        const linkStr = await redis.get(getWebhookKey(eventCode));
        const link = parseJsonSafe(linkStr, null);
        return res.json({
          linked: Boolean(link?.webhookUrl),
          linkedAt: link?.linkedAt || null,
          linkedBy: link?.linkedBy || null
        });
      } catch (e) {
        console.error('Discord webhook link GET error:', e.message);
        return res.status(500).json({ error: 'Internal server error' });
      }
    }
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (discordAction === 'notify') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const notifySecret = process.env.DISCORD_NOTIFY_SECRET;
      if (notifySecret) {
        const provided = String(req.headers['x-notify-secret'] || '');
        if (provided !== notifySecret) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }

      const eventCode = String(req.body?.eventCode || '').trim().toUpperCase();
      const kind = req.body?.kind === 'end' ? 'end' : 'refresh';
      const username = String(req.body?.username || '').trim();
      const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object' ? req.body.snapshot : null;
      if (!eventCode) return res.status(400).json({ error: 'eventCode is required' });

      const eventStr = await redis.get(getEventKey(eventCode));
      const event = parseJsonSafe(eventStr, null);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (username && event.owner && username !== event.owner) {
        return res.status(403).json({ error: 'Only event owner may trigger notifications' });
      }

      const linkStr = await redis.get(getWebhookKey(eventCode));
      const link = parseJsonSafe(linkStr, null);
      if (!link?.webhookUrl) {
        return res.json({ ok: true, sent: 0, skipped: 0, reason: 'No linked webhook' });
      }

      const digest = buildDigest({
        kind,
        metricValue: snapshot?.metricValue ?? event?.current?.metricValue ?? 0,
        playerValues: snapshot?.playerValues ?? event?.current?.playerValues ?? {}
      });
      const now = Date.now();

      const embed = buildEmbed({ event, kind, snapshot });
      const sendResult = await sendDiscordWebhook(link.webhookUrl, { embeds: [embed] });
      if (!sendResult.ok) {
        return res.status(500).json({ ok: false, sent: 0, failed: 1, skipped: 0, error: sendResult.error });
      }

      const stateKey = getNotifyStateKey(eventCode);
      await redis.set(stateKey, JSON.stringify({ digest, lastKind: kind, lastSentAt: now }));
      return res.json({ ok: true, sent: 1, failed: 0, skipped: 0 });
    } catch (e) {
      console.error('Discord notify error:', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

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
        const hasIncomingBaseline = event.baseline != null && typeof event.baseline === 'object';
        const baseline =
          hasIncomingBaseline && event.baseline
            ? event.baseline
            : existing && existing.baseline && typeof existing.baseline === 'object'
              ? existing.baseline
              : { metricValue: 0, playerValues: {} };
        const record = {
          eventCode: normalizedCode,
          owner: normalizedUser,
          isPublic: Boolean(event.isPublic),
          guildName: event.guildName || null,
          metric: event.metric || 'xp',
          scope: event.scope || 'selected',
          trackedPlayers: Array.isArray(event.trackedPlayers) ? event.trackedPlayers : [],
          startedAt: Number(event.startedAt || Date.now()),
          refreshCooldownMs: (() => {
            const v = Number(event.refreshCooldownMs);
            return Number.isFinite(v) ? v : 5 * 60 * 1000;
          })(),
          baseline,
          current: event.current || event.baseline || existing?.current || baseline || { metricValue: 0, playerValues: {} },
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
