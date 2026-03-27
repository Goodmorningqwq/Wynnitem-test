const { getEventRecord, normalizeEventCode, notifyLinkedChannels } = require('../../proxy/discord-links');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const notifySecret = process.env.DISCORD_NOTIFY_SECRET;
    if (notifySecret) {
      const provided = String(req.headers['x-notify-secret'] || '');
      if (provided !== notifySecret) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const eventCode = normalizeEventCode(req.body?.eventCode);
    const kind = req.body?.kind === 'end' ? 'end' : 'refresh';
    const username = String(req.body?.username || '').trim();
    const snapshot = req.body?.snapshot && typeof req.body.snapshot === 'object' ? req.body.snapshot : null;
    if (!eventCode) {
      return res.status(400).json({ error: 'eventCode is required' });
    }
    const event = await getEventRecord(eventCode);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (username && event.owner && username !== event.owner) {
      return res.status(403).json({ error: 'Only event owner may trigger notifications' });
    }

    const result = await notifyLinkedChannels({
      eventCode,
      kind,
      event,
      snapshot
    });
    if (!result.ok) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (e) {
    console.error('Discord notify error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
