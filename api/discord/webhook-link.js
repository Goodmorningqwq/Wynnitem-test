const { getEventRecord, normalizeEventCode, upsertWebhookLink, getWebhookLink } = require('../../proxy/discord-links');

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    try {
      const eventCode = normalizeEventCode(req.body?.eventCode);
      const webhookUrl = String(req.body?.webhookUrl || '').trim();
      const username = String(req.body?.username || '').trim();
      const linkedByDisplay = String(req.body?.linkedByDisplay || '').trim();
      if (!eventCode || !webhookUrl || !username) {
        return res.status(400).json({ error: 'eventCode, webhookUrl, and username are required' });
      }

      const result = await upsertWebhookLink(eventCode, {
        webhookUrl,
        username,
        linkedByDisplay
      });
      if (!result.ok) {
        const status = result.error === 'Event code does not exist' ? 404 : result.error.includes('owner') ? 403 : 400;
        return res.status(status).json(result);
      }
      return res.json({
        success: true,
        eventCode,
        linkedBy: result.link?.linkedBy || username
      });
    } catch (e) {
      console.error('Discord webhook link POST error:', e.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'GET') {
    try {
      const eventCode = normalizeEventCode(req.query?.eventCode);
      const username = String(req.query?.username || '').trim();
      if (!eventCode || !username) {
        return res.status(400).json({ error: 'eventCode and username are required' });
      }
      const event = await getEventRecord(eventCode);
      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.owner && username !== event.owner) {
        return res.status(403).json({ error: 'Only event owner may view webhook link status' });
      }
      const link = await getWebhookLink(eventCode);
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
};
