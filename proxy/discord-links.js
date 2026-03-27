const crypto = require('crypto');
const { Redis } = require('@upstash/redis');

const WEBHOOK_KEY_PREFIX = 'guild:event:discord:webhook:';
const EVENT_KEY_PREFIX = 'guild:event:code:';
const NOTIFY_STATE_KEY_PREFIX = 'guild:event:discord:notify:';
const REFRESH_NOTIFY_COOLDOWN_MS = 45 * 1000;

let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL_GUILD && process.env.UPSTASH_REDIS_REST_TOKEN_GUILD) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL_GUILD,
    token: process.env.UPSTASH_REDIS_REST_TOKEN_GUILD
  });
}

function hasRedis() {
  return Boolean(redis);
}

function normalizeEventCode(code) {
  return String(code || '').trim().toUpperCase();
}

function getEventKey(code) {
  return `${EVENT_KEY_PREFIX}${normalizeEventCode(code)}`;
}

function getWebhookKey(code) {
  return `${WEBHOOK_KEY_PREFIX}${normalizeEventCode(code)}`;
}

function getNotifyStateKey(code) {
  return `${NOTIFY_STATE_KEY_PREFIX}${normalizeEventCode(code)}`;
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

async function getEventRecord(code) {
  if (!hasRedis()) return null;
  const eventStr = await redis.get(getEventKey(code));
  const event = parseJsonSafe(eventStr, null);
  return event && typeof event === 'object' ? event : null;
}

function isLikelyDiscordWebhookUrl(url) {
  const value = String(url || '').trim();
  return /^https:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/i.test(value);
}

async function getWebhookLink(code) {
  if (!hasRedis()) return null;
  const linkStr = await redis.get(getWebhookKey(code));
  const link = parseJsonSafe(linkStr, null);
  if (!link || typeof link !== 'object') return null;
  return link;
}

async function upsertWebhookLink(code, row) {
  if (!hasRedis()) {
    return { ok: false, error: 'Redis is not configured' };
  }
  const eventCode = normalizeEventCode(code);
  if (!eventCode) {
    return { ok: false, error: 'Event code is required' };
  }
  const event = await getEventRecord(eventCode);
  if (!event) {
    return { ok: false, error: 'Event code does not exist' };
  }
  if (event.owner && row.username && event.owner !== row.username) {
    return { ok: false, error: 'Only event owner can link webhook' };
  }
  if (!isLikelyDiscordWebhookUrl(row.webhookUrl)) {
    return { ok: false, error: 'Invalid Discord webhook URL' };
  }
  const now = Date.now();
  const record = {
    webhookUrl: String(row.webhookUrl || '').trim(),
    linkedBy: String(row.username || ''),
    linkedByDisplay: String(row.linkedByDisplay || ''),
    linkedAt: now
  };
  await redis.set(getWebhookKey(eventCode), JSON.stringify(record));
  return { ok: true, event, link: record };
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
  const playerValues = snapshot?.playerValues || event.current?.playerValues || {};
  const top = Object.entries(playerValues)
    .map(([name, value]) => ({ name, value: Number(value || 0) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const topText = top.length
    ? top.map((row, idx) => `#${idx + 1} ${row.name} — ${row.value.toLocaleString()}`).join('\n')
    : 'No player values';

  return {
    title: kind === 'end' ? 'Event Ended' : 'Leaderboard Refreshed',
    description: `${event.guildName || 'Unknown Guild'} • ${metricLabel} • ${scopeLabel}`,
    color: kind === 'end' ? 0xef4444 : 0x8b5cf6,
    fields: [
      { name: 'Event Code', value: event.eventCode || '-', inline: true },
      { name: 'Current', value: current.toLocaleString(), inline: true },
      { name: 'Delta', value: `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`, inline: true },
      { name: 'Top Players', value: topText, inline: false }
    ],
    footer: { text: kind === 'end' ? 'Final summary' : 'Auto refresh update' },
    timestamp: new Date().toISOString()
  };
}

async function sendDiscordWebhook(webhookUrl, payload) {
  const url = String(webhookUrl || '').trim();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
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

async function notifyLinkedChannels({ eventCode, kind, event, snapshot }) {
  if (!hasRedis()) {
    return { ok: false, error: 'Redis is not configured' };
  }
  const code = normalizeEventCode(eventCode);
  const link = await getWebhookLink(code);
  if (!link?.webhookUrl) {
    return { ok: true, sent: 0, skipped: 0, reason: 'No linked webhook' };
  }

  const stateKey = getNotifyStateKey(code);
  const lastStateStr = await redis.get(stateKey);
  const lastState = parseJsonSafe(lastStateStr, {});
  const digest = buildDigest({
    kind,
    metricValue: snapshot?.metricValue ?? event?.current?.metricValue ?? 0,
    playerValues: snapshot?.playerValues ?? event?.current?.playerValues ?? {}
  });
  const now = Date.now();

  if (kind === 'refresh') {
    const sameDigest = String(lastState.digest || '') === digest;
    const cooldownHit = now - Number(lastState.lastSentAt || 0) < REFRESH_NOTIFY_COOLDOWN_MS;
    if (sameDigest || cooldownHit) {
      return { ok: true, sent: 0, skipped: 1, reason: sameDigest ? 'Unchanged snapshot' : 'Cooldown active' };
    }
  }

  const embed = buildEmbed({ event, kind, snapshot });
  const result = await sendDiscordWebhook(link.webhookUrl, {
    embeds: [embed]
  });
  if (!result.ok) {
    console.error('Discord webhook send failed:', result.status || 0, result.error || '');
    return { ok: false, sent: 0, failed: 1, skipped: 0, error: result.error };
  }

  await redis.set(stateKey, JSON.stringify({
    digest,
    lastKind: kind,
    lastSentAt: now
  }));

  return { ok: true, sent: 1, failed: 0, skipped: 0 };
}

module.exports = {
  hasRedis,
  normalizeEventCode,
  getEventRecord,
  upsertWebhookLink,
  getWebhookLink,
  notifyLinkedChannels
};
