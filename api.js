// Wynncraft Item API Wrapper

// The frontend calls a local proxy to avoid CORS.
const API_BASE = '/api/item';

const DATABASE_ENDPOINT = `${API_BASE}/database`;
const METADATA_ENDPOINT = `${API_BASE}/metadata`;
const SEARCH_ENDPOINT = `${API_BASE}/database`;

// Wynncraft Search API endpoints (for reference)
// GET https://api.wynncraft.com/v3/item/search/<str:query>
// GET https://api.wynncraft.com/v3/item/search/

// Item cache constants
const ITEM_CACHE_KEY = 'wynnitem_item_cache';
const ITEM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function getItemCacheFromStorage() {
  try {
    const cached = localStorage.getItem(ITEM_CACHE_KEY);
    return cached ? JSON.parse(cached) : {};
  } catch {
    return {};
  }
}

function setItemCacheToStorage(cache) {
  try {
    localStorage.setItem(ITEM_CACHE_KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('localStorage full, clearing old cache');
    try {
      localStorage.removeItem(ITEM_CACHE_KEY);
    } catch {}
  }
}

export const itemCache = {
  get(name) {
    const cache = getItemCacheFromStorage();
    const entry = cache[name];
    if (!entry) return null;
    if (Date.now() > entry.timestamp + ITEM_CACHE_TTL) {
      delete cache[name];
      setItemCacheToStorage(cache);
      return null;
    }
    return entry.data;
  },
  
  set(name, data) {
    const cache = getItemCacheFromStorage();
    cache[name] = { data, timestamp: Date.now() };
    setItemCacheToStorage(cache);
  },
  
  has(name) {
    return this.get(name) !== null;
  },
  
  getAll() {
    return getItemCacheFromStorage();
  },
  
  clear() {
    try {
      localStorage.removeItem(ITEM_CACHE_KEY);
    } catch {}
  }
};

export async function fetchItemByName(name) {
  const cached = itemCache.get(name);
  if (cached) return cached;
  
  const url = buildUrl(`${API_BASE}/quick`);
  url.searchParams.set('query', name);
  
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  
  const data = await response.json();
  const item = data[name];
  
  if (item) {
    itemCache.set(name, item);
  }
  
  return item || null;
}

export async function refreshStaleItems() {
  const cache = getItemCacheFromStorage();
  const now = Date.now();
  const staleThreshold = 60 * 60 * 1000; // 1 hour
  
  const staleItems = Object.entries(cache)
    .filter(([_, entry]) => now - entry.timestamp > staleThreshold);
  
  console.log(`[ItemCache] Refreshing ${staleItems.length} stale items...`);
  
  for (const [name] of staleItems) {
    try {
      const url = buildUrl(`${API_BASE}/quick`);
      url.searchParams.set('query', name);
      const response = await fetch(url.toString());
      if (response.ok) {
        const data = await response.json();
        if (data[name]) {
          itemCache.set(name, data[name]);
        }
      }
    } catch (e) {
      console.warn(`Failed to refresh ${name}:`, e.message);
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`[ItemCache] Refresh complete`);
}

const ITEM_TYPES = ['weapon', 'armour'];
const TIER_ORDER = ['mythic', 'fabled', 'legendary', 'epic', 'rare', 'uncommon', 'common'];

// Category definitions
const ARMOUR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const ACCESSORY_TYPES = ['ring', 'bracelet', 'necklace'];
const MISC_TYPES = ['charm', 'tome'];

function buildUrl(endpointPath) {
  if (endpointPath.startsWith('http://') || endpointPath.startsWith('https://')) {
    return new URL(endpointPath);
  }
  return new URL(endpointPath, window.location.origin);
}

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
      filtered.push({ name, ...item });
    }
  }
  
  filtered.sort((a, b) => getTierIndex(a.rarity) - getTierIndex(b.rarity));
  
  return filtered;
}

export function filterByArmourType(items, armourTypes) {
  const filtered = [];
  const typesLower = armourTypes.map(t => t.toLowerCase());
  
  for (const [name, item] of Object.entries(items)) {
    const itemArmourType = item.armourType?.toLowerCase();
    if (itemArmourType && typesLower.includes(itemArmourType)) {
      filtered.push({ name, ...item });
    }
  }
  
  filtered.sort((a, b) => getTierIndex(a.rarity) - getTierIndex(b.rarity));
  
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
  const allItems = {};
  let page = 1;
  let hasMore = true;
  let cachedCount = 0;
  
  while (hasMore) {
    const url = buildUrl(DATABASE_ENDPOINT);
    url.searchParams.set('page', page.toString());
    
    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`API Error: ${response.status}`);
    }
    
    const data = await response.json();
    const results = data.results || {};
    const isCached = response.headers.get('X-Cache') === 'HIT';
    
    if (isCached) {
      cachedCount++;
    }
    
    if (Object.keys(results).length === 0) {
      hasMore = false;
      break;
    }
    
    Object.assign(allItems, results);
    
    if (onProgress) {
      const totalPages = data.controller?.pages || 276;
      const itemCount = Object.keys(allItems).length;
      onProgress(page, totalPages, itemCount, cachedCount);
    }
    
    const nextPage = data.controller?.next;
    if (!nextPage || page >= 276) {
      hasMore = false;
    } else {
      page++;
    }
    
    if (!isCached) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  
  let filteredItems = {};
  
  for (const [name, item] of Object.entries(allItems)) {
    const itemType = item.type?.toLowerCase();
    const itemArmorType = item.armourType?.toLowerCase();
    const itemWeaponType = item.weaponType?.toLowerCase();
    
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
      if (itemType !== 'tome' && itemType !== 'charm') continue;
      if (miscType && itemType !== miscType) continue;
    }
    
    if (tier && item.rarity?.toLowerCase() !== tier.toLowerCase()) continue;
    
    const itemLevel = item.requirements?.level;
    if (levelMin != null && (itemLevel == null || itemLevel < levelMin)) continue;
    if (levelMax != null && (itemLevel == null || itemLevel > levelMax)) continue;
    
    filteredItems[name] = item;
  }
  
  console.log(`[DEBUG] Filtering: category=${category}, weaponType=${weaponType}, totalItems=${Object.keys(allItems).length}, filteredCount=${Object.keys(filteredItems).length}`);
  
  return {
    items: filteredItems,
    totalCount: Object.keys(filteredItems).length,
    cachedPages: cachedCount
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

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }
  return await response.json();
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
