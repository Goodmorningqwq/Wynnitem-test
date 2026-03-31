/**
 * Server-side proxy for Wynncraft guild territory list (browser CORS blocks direct calls).
 */
module.exports = async function territoriesApi(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const upstream = await fetch(
      'https://api.wynncraft.com/v3/guild/list/territory',
      {
        headers: { Accept: 'application/json' }
      }
    );

    const text = await upstream.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Wynncraft API error: ${upstream.status}`,
        detail: data
      });
    }

    return res.status(200).setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30').json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Proxy error';
    return res.status(500).json({ error: msg });
  }
};
