const express = require('express');
const path = require('path');
const fs = require('fs');
const { getEventRecord, normalizeEventCode, notifyLinkedChannels, upsertWebhookLink, getWebhookLink } = require('./discord-links');

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

app.use(express.json({ limit: '10mb' }));

const WYNCRAFT_BASE = 'https://api.wynncraft.com/v3/item/database';

const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function getCacheFile(key) {
  const safeKey = key.replace(/[^a-zA-Z0-9-_]/g, '_');
  return path.join(CACHE_DIR, `cache_${safeKey}.json`);
}

function getCached(key) {
  try {
    const cacheFile = getCacheFile(key);
    if (!fs.existsSync(cacheFile)) return null;
    
    const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (Date.now() > data.expiresAt) {
      fs.unlinkSync(cacheFile);
      return null;
    }
    return data.value;
  } catch (e) {
    return null;
  }
}

function setCached(key, value, ttlMs) {
  try {
    const cacheFile = getCacheFile(key);
    const data = {
      value,
      expiresAt: Date.now() + ttlMs,
    };
    fs.writeFileSync(cacheFile, JSON.stringify(data));
  } catch (e) {
    console.error('Cache write error:', e.message);
  }
}

async function forwardJson({ targetUrl, method = 'GET', body, cacheKey, ttlMs }, res) {
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      return res.json(cached);
    }
  }

  const upstreamRes = await fetch(targetUrl, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const rawText = await upstreamRes.text();
  let payload;
  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = rawText;
  }

  if (!upstreamRes.ok) {
    res.setHeader('X-Cache', 'MISS');
    if (upstreamRes.status === 429) {
      res.setHeader('Retry-After', '60');
    }
    return res.status(upstreamRes.status).json(payload);
  }

  if (cacheKey && ttlMs) {
    setCached(cacheKey, payload, ttlMs);
  }

  res.setHeader('X-Cache', 'MISS');
  return res.json(payload);
}

// In-memory cache for combined pages
const pageCache = new Map();

app.get('/api/item/database', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const cacheKey = `page_${page}`;
  
  // Check in-memory cache first
  if (pageCache.has(cacheKey)) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(pageCache.get(cacheKey));
  }
  
  // Check disk cache
  const cached = getCached(cacheKey);
  if (cached) {
    pageCache.set(cacheKey, cached);
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  
  // Fetch from API
  const url = `${WYNCRAFT_BASE}?page=${page}`;
  
  try {
    const upstreamRes = await fetch(url);
    const rawText = await upstreamRes.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = rawText;
    }
    
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }
    
    // Cache in memory and disk
    pageCache.set(cacheKey, data);
    setCached(cacheKey, data, 24 * 60 * 60 * 1000);
    
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/item/all-pages', async (req, res) => {
  const cacheKey = 'all_pages_cache';
  
  // Check memory cache
  if (pageCache.has(cacheKey)) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(pageCache.get(cacheKey));
  }
  
  // Check disk cache
  const cached = getCached(cacheKey);
  if (cached) {
    pageCache.set(cacheKey, cached);
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  
  // Fetch all pages
  res.setHeader('Content-Type', 'application/json');
  res.write('{"results":{');
  
  let first = true;
  for (let page = 1; page <= 276; page++) {
    const pageCacheKey = `page_${page}`;
    
    // Check cache for each page
    let pageData = pageCache.get(pageCacheKey);
    
    if (!pageData) {
      pageData = getCached(pageCacheKey);
    }
    
    if (!pageData) {
      const url = `${WYNCRAFT_BASE}?page=${page}`;
      try {
        const upstreamRes = await fetch(url);
        if (upstreamRes.ok) {
          pageData = await upstreamRes.json();
          pageCache.set(pageCacheKey, pageData);
          setCached(pageCacheKey, pageData, 24 * 60 * 60 * 1000);
        }
      } catch (e) {
        console.error(`Error fetching page ${page}:`, e.message);
      }
      // Rate limit
      await new Promise(r => setTimeout(r, 1600));
    }
    
    if (pageData && pageData.results) {
      for (const [name, item] of Object.entries(pageData.results)) {
        if (!first) res.write(',');
        first = false;
        res.write(`"${name}":${JSON.stringify(item)}`);
      }
    }
    
    // Send progress
    res.write(`{"page":${page},"total":276}`);
    res.flushHeaders();
  }
  
  res.write('}}');
  res.end();
});

app.get('/api/item/metadata', async (req, res) => {
  const url = `https://api.wynncraft.com/v3/item/metadata`;
  const cacheKey = `GET ${url}`;
  return forwardJson({ targetUrl: url, cacheKey, ttlMs: 60 * 60 * 1000 }, res);
});

app.get('/api/item/quick', async (req, res) => {
  const query = req.query.query || '';
  const cacheKey = `quick_${query}`;
  
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  
  const url = `https://api.wynncraft.com/v3/item/search/${encodeURIComponent(query)}`;
  
  try {
    const upstreamRes = await fetch(url);
    const data = await upstreamRes.json();
    
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }
    
    setCached(cacheKey, data, 24 * 60 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/item/search/:query', async (req, res) => {
  const query = req.params.query;
  const cacheKey = `search_${query}`;
  
  const cached = getCached(cacheKey);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return res.json(cached);
  }
  
  const url = `https://api.wynncraft.com/v3/item/search/${encodeURIComponent(query)}`;
  
  try {
    const upstreamRes = await fetch(url);
    const data = await upstreamRes.json();
    
    if (!upstreamRes.ok) {
      if (upstreamRes.status === 429) {
        res.setHeader('Retry-After', '60');
      }
      return res.status(upstreamRes.status).json(data);
    }
    
    setCached(cacheKey, data, 60 * 60 * 1000);
    res.setHeader('X-Cache', 'MISS');
    return res.json(data);
  } catch (e) {
    console.error('Proxy error:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/api/item/clear-cache', (req, res) => {
  pageCache.clear();
  
  try {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.startsWith('cache_')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
    res.json({ success: true, message: 'Cache cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/discord/notify', async (req, res) => {
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
});

app.post('/api/discord/webhook-link', async (req, res) => {
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
    console.error('Discord webhook link error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/discord/webhook-link', async (req, res) => {
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
});

const repoRoot = path.join(__dirname, '..');

app.use((req, res, next) => {
  const pathname = req.path;
  
  if (req.method === 'GET') {
    if (pathname === '/' || pathname === '/guild' || pathname === '/item' || pathname === '/login') {
      const htmlFile = pathname === '/' ? '/index.html' : `${pathname}.html`;
      return res.sendFile(path.join(repoRoot, htmlFile), (err) => {
        if (err) {
          return res.status(404).send(`Cannot GET ${pathname}`);
        }
      });
    }
    
    if (pathname.endsWith('.html') || pathname.endsWith('.js') || pathname.endsWith('.css')) {
      return express.static(repoRoot)(req, res, next);
    }
  }
  
  next();
});

app.listen(PORT, () => {
  console.log(`openclaw proxy listening on http://localhost:${PORT}`);
  console.log(`Cache directory: ${CACHE_DIR}`);
});
