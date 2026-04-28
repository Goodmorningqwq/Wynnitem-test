// Wynncraft Item API Wrapper

// The frontend calls a local proxy to avoid CORS.
const API_BASE = '/api/item';

// App Version for Cache Busting Server Endpoints
const APP_VERSION = '1.1.0';

const DATABASE_ENDPOINT = `${API_BASE}/database?v=${APP_VERSION}`;
const METADATA_ENDPOINT = `${API_BASE}/metadata?v=${APP_VERSION}`;
const SEARCH_ENDPOINT = `${API_BASE}/database?v=${APP_VERSION}`;
const REFRESH_ENDPOINT = `${API_BASE}/refresh?v=${APP_VERSION}`;

// Wynncraft Search API endpoints (for reference)
// GET https://api.wynncraft.com/v3/item/search/<str:query>
// GET https://api.wynncraft.com/v3/item/search/

function buildUrl(endpointPath) {
  if (endpointPath.startsWith('http://') || endpointPath.startsWith('https://')) {
    return new URL(endpointPath);
  }
  return new URL(endpointPath, window.location.origin);
}

const ITEM_TYPES = ['weapon', 'armour'];
const TIER_ORDER = ['mythic', 'fabled', 'legendary', 'epic', 'rare', 'uncommon', 'common'];

// Category definitions
const ARMOUR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const ACCESSORY_TYPES = ['ring', 'bracelet', 'necklace'];
const MISC_TYPES = ['charm', 'tome'];

/**
 * Fetch single page of items
 * @param {number} page - Page number (1-indexed)
 * @returns {Promise<Object>}
 */
export async function fetchItems(page = 1) {
  const url = buildUrl(DATABASE_ENDPOINT);
  url.searchParams.set('page', page.toString());
  
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  return await response.json();
}

const pageCache = new Map();
let totalItemCount = 0;
let totalPages = 276;
let rateLimitedUntil = 0;
let lastFetchTime = 0;
let consecutiveErrors = 0;

const MIN_FETCH_INTERVAL = 1500;

export function clearPageCache() {
  pageCache.clear();
  totalItemCount = 0;
  consecutiveErrors = 0;
}

export async function fetchItemPages(startPage, count = 20) {
  if (Date.now() < rateLimitedUntil) {
    console.log('Still rate limited, skipping fetch');
    return { success: false, rateLimited: true };
  }

  const pages = [];
  for (let i = 0; i < count; i++) {
    const pageNum = startPage + i;
    if (pageNum <= 276 && !pageCache.has(pageNum)) {
      pages.push(pageNum);
    }
  }

  if (pages.length === 0) return { success: true, cached: true };

  const results = [];
  for (const page of pages) {
    if (Date.now() < rateLimitedUntil) {
      console.log('Rate limited during batch, stopping');
      break;
    }

    const now = Date.now();
    const waitTime = Math.max(0, MIN_FETCH_INTERVAL - (now - lastFetchTime));
    if (waitTime > 0) {
      await new Promise(r => setTimeout(r, waitTime));
    }
    lastFetchTime = Date.now();

    try {
      const data = await fetchItems(page);
      pageCache.set(page, data.results || {});
      if (totalItemCount === 0) {
        totalItemCount = data.controller?.count || 0;
      }
      consecutiveErrors = 0;
      results.push({ page, success: true });
    } catch (e) {
      console.error(`Failed to fetch page ${page}:`, e.message);
      consecutiveErrors++;
      
      if (e.message.includes('429') || e.message.includes('rate')) {
        rateLimitedUntil = Date.now() + 60000;
        console.log('Rate limited, waiting 60 seconds...');
        break;
      }
      
      if (consecutiveErrors >= 3) {
        rateLimitedUntil = Date.now() + 30000;
        console.log('Multiple errors, waiting 30 seconds...');
        break;
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  return { success: true, fetched: results.length };
}

export function getAllFetchedItems() {
  const allItems = {};
  const sortedPages = Array.from(pageCache.keys()).sort((a, b) => a - b);
  for (const page of sortedPages) {
    const items = pageCache.get(page);
    Object.assign(allItems, items);
  }
  return allItems;
}

export function getTotalItemCount() {
  return totalItemCount;
}

export function getLoadedPageCount() {
  return pageCache.size;
}

function getTierIndex(tier) {
  const t = tier?.toLowerCase();
  const idx = TIER_ORDER.indexOf(t);
  return idx === -1 ? TIER_ORDER.length : idx;
}

export function filterAndSortItems(items, types = ITEM_TYPES) {
  const filtered = [];
  
  for (const [name, item] of Object.entries(items)) {
    if (types.includes(item.type?.toLowerCase())) {
      const realName = item.displayName || item.name || name;
      filtered.push({ name: realName, ...item });
    }
  }
  
  filtered.sort((a, b) => getTierIndex(a.tier || a.rarity) - getTierIndex(b.tier || b.rarity));
  
  return filtered;
}

export function filterByArmourType(items, armourTypes) {
  const filtered = [];
  const typesLower = armourTypes.map(t => t.toLowerCase());
  
  for (const [name, item] of Object.entries(items)) {
    const itemArmourType = (item.armourType || item.subType)?.toLowerCase();
    if (itemArmourType && typesLower.includes(itemArmourType)) {
      const realName = item.displayName || item.name || name;
      filtered.push({ name: realName, ...item });
    }
  }
  
  filtered.sort((a, b) => getTierIndex(a.tier || a.rarity) - getTierIndex(b.tier || b.rarity));
  
  return filtered;
}

export function filterByCategory(items, category) {
  if (category === 'weapon') {
    return filterAndSortItems(items, ['weapon']);
  }
  if (category === 'armour') {
    return filterAndSortItems(items, ['armour']);
  }
  if (category === 'accessory') {
    return filterByArmourType(items, ACCESSORY_TYPES);
  }
  if (category === 'misc') {
    return filterByArmourType(items, MISC_TYPES);
  }
  return filterAndSortItems(items, ITEM_TYPES);
}

/**
 * Fetch filtered items from the API
 * Wynncraft API only supports 'page' parameter, so all other filtering is done client-side
 * Uses cached pages from proxy for faster subsequent loads
 * @param {Object} options - Filter options
 * @param {string} options.category - 'weapon', 'armour', 'accessory', 'misc'
 * @param {string} options.weaponType - 'bow', 'wand', 'dagger', 'spear', 'relik'
 * @param {string} options.armourType - 'helmet', 'chestplate', 'leggings', 'boots'
 * @param {string} options.accessoryType - 'ring', 'bracelet', 'necklace'
 * @param {string} options.miscType - 'tome', 'charm'
 * @param {string} options.tier - tier filter
 * @param {number} options.levelMin - minimum level
 * @param {number} options.levelMax - maximum level
 * @param {function} onProgress - callback for progress updates
 * @returns {Promise<Object>} - { items: array, totalCount: number }
 */
export async function fetchFilteredItems(options = {}, onProgress) {
  console.log('[DEBUG] fetchFilteredItems called:', options);
  const { category, weaponType, armourType, accessoryType, miscType, tier, levelMin, levelMax } = options;
  const totalStartTime = Date.now();
  
  onProgress?.(0, 1, 0, 0);
  
  const url = buildUrl(DATABASE_ENDPOINT);
  const response = await fetch(url.toString());
  const fetchTime = Date.now() - totalStartTime;
  const cacheStatus = response.headers.get('X-Cache') || 'UNKNOWN';
  
  console.log(`[DEBUG] Full DB fetched: ${cacheStatus} - ${fetchTime}ms`);
  
  if (!response.ok) {
    let errorPayload = null;
    try {
      errorPayload = await response.json();
    } catch {
      errorPayload = null;
    }
    throw new Error(errorPayload?.error || `API Error: ${response.status}`);
  }
  
  onProgress?.(1, 1, 0, 0);
  
  const allItems = await response.json();
  const results = allItems.results || {};
  const totalItems = Object.keys(results).length;
  
  console.log(`[DEBUG] Got ${totalItems} items, now filtering...`);
  
  let filteredItems = {};
  
  for (const [name, item] of Object.entries(results)) {
    const itemType = item.type?.toLowerCase();
    const itemArmorType = (item.armourType || item.subType)?.toLowerCase();
    const itemWeaponType = (item.weaponType || item.subType)?.toLowerCase();
    
    if (category === 'weapon') {
      if (itemType !== 'weapon') continue;
      if (weaponType && itemWeaponType !== weaponType) continue;
    } else if (category === 'armour') {
      if (itemType !== 'armour') continue;
      if (armourType && itemArmorType !== armourType) continue;
    } else if (category === 'accessory') {
      if (itemType !== 'accessory') continue;
      if (accessoryType && itemArmorType !== accessoryType) continue;
    } else if (category === 'misc') {
      if (itemType !== 'tome' && itemType !== 'charm' && itemType !== 'misc') continue;
      if (miscType && itemType !== miscType) continue;
    }
    
    const objTier = item.tier || item.rarity;
    if (tier && objTier?.toLowerCase() !== tier.toLowerCase()) continue;
    
    const itemLevel = item.requirements?.level;
    if (levelMin != null && (itemLevel == null || itemLevel < levelMin)) continue;
    if (levelMax != null && (itemLevel == null || itemLevel > levelMax)) continue;
    
    const realName = item.displayName || item.internalName || item.name || name;
    filteredItems[realName] = item;
  }
  
  const filterTime = Date.now() - totalStartTime;
  console.log(`[DEBUG] Done! Filtered ${totalItems} -> ${Object.keys(filteredItems).length} items in ${filterTime}ms`);
  
  onProgress?.(1, 1, Object.keys(filteredItems).length, 276);
  
  return {
    items: filteredItems,
    totalCount: Object.keys(filteredItems).length,
    cachedPages: cacheStatus.includes('HIT') ? 1 : 0,
    cacheMode: cacheStatus,
    staleSnapshot: cacheStatus === 'LAST-GOOD-HIT'
  };
}

/**
 * Quick search for items by name
 * @param {string} query - Search query
 * @returns {Promise<Object>}
 */
export async function quickSearch(query) {
  const url = buildUrl(`${API_BASE}/quick`);
  url.searchParams.set('query', query);
  console.log('[DEBUG] quickSearch URL:', url.toString());

  const response = await fetch(url.toString());
  const cacheStatus = response.headers.get('X-Cache');
  console.log('[DEBUG] quickSearch response status:', response.status, 'X-Cache:', cacheStatus);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  const data = await response.json();
  console.log('[DEBUG] quickSearch response keys:', Object.keys(data));
  return data;
}

export async function triggerItemRefresh(adminToken, mode = 'quick') {
  const token = String(adminToken || '').trim();
  if (!token) {
    throw new Error('Missing admin token');
  }
  const url = buildUrl(REFRESH_ENDPOINT);
  const refreshMode = mode === 'full' ? 'full' : 'quick';
  url.searchParams.set('mode', refreshMode);
  // Add a nonce so each admin refresh request bypasses any intermediary cache.
  url.searchParams.set('_ts', String(Date.now()));
  const response = await fetch(url.toString(), {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'x-cache-admin-token': token
    }
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const err = new Error(payload?.error || `API Error: ${response.status}`);
    err.status = response.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

/**
 * Advanced item search - uses GET with client-side filtering
 * @param {Object} filters - Search filters
 * @returns {Promise<Object>}
 */
export async function advancedSearch(filters = {}, page = 1) {
  const url = buildUrl(DATABASE_ENDPOINT);
  url.searchParams.set('page', page.toString());
  
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  const data = await response.json();
  
  let items = data.results || {};
  
  if (filters.type && filters.type.length > 0) {
    items = filterItemsByType(items, filters.type);
  }
  if (filters.tier) {
    const tierFilter = Array.isArray(filters.tier) ? filters.tier : [filters.tier];
    const filtered = {};
    for (const [name, item] of Object.entries(items)) {
      if (tierFilter.includes(item.rarity?.toLowerCase())) {
        filtered[name] = item;
      }
    }
    items = filtered;
  }
  
  return { ...data, results: items };
}

/**
 * Fetch item metadata (available filters)
 * @returns {Promise<Object>}
 */
export async function fetchMetadata() {
  const response = await fetch(METADATA_ENDPOINT);
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  return await response.json();
}

/**
 * Get single item by name
 * @param {string} name - Item name
 * @returns {Promise<Object>}
 */
export async function getItemByName(name) {
  const data = await fetchItems(1, true);
  // With `?fullResult`, the API returns item data directly.
  return data?.[name] || null;
}

/**
 * Cache management
 */
const cache = {
  data: new Map(),
  ttl: 60 * 60 * 1000, // 1 hour (matches API TTL)
  
  get(key) {
    const item = this.data.get(key);
    if (!item) return null;
    if (Date.now() > item.timestamp + this.ttl) {
      this.data.delete(key);
      return null;
    }
    return item.value;
  },
  
  set(key, value) {
    this.data.set(key, {
      value,
      timestamp: Date.now(),
    });
  },
  
  clear() {
    this.data.clear();
  },
};

export { cache };
