const express = require('express');
const path = require('path');
const fs = require('fs');

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

const repoRoot = path.join(__dirname, '..');
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path.endsWith('.html') || req.path.endsWith('.js') || req.path === '/')) {
    return express.static(repoRoot)(req, res, next);
  }
  next();
});

app.listen(PORT, () => {
  console.log(`openclaw proxy listening on http://localhost:${PORT}`);
  console.log(`Cache directory: ${CACHE_DIR}`);
});
