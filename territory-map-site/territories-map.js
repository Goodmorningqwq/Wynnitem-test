/** @typedef {Record<string, string>} ResourceSet */
/** @typedef {{ name: string, resources: ResourceSet, tradeRoutes: string[], guild: { uuid: string, name: string, prefix: string }, acquired: string, minX: number, maxX: number, minZ: number, maxZ: number, emeralds: number, wood: number, ore: number, crops: number, fish: number, dominant: string, productionScore: number, ownerLabel: string }} MergedTerritory */

const STATIC_TERRITORIES_URL =
  'https://raw.githubusercontent.com/jakematt123/Wynncraft-Territory-Info/main/territories.json';
/** Same-origin proxy (api/territories.js) — avoids browser CORS on wynncraft.com */
const LIVE_TERRITORIES_URL = '/api/territories';
const MAP_IMAGE_URL = '/main-map.webp';

/**
 * Fixed world bounds for bottom-middle origin projection.
 * Calibration guide:
 * - x=0 maps to horizontal center.
 * - z=0 maps near the bottom edge.
 * - Tune these four values until known territory corners align.
 */
const MAP_X_MIN = -2500;
const MAP_X_MAX = 2500;
const MAP_Z_MIN = -6635;
const MAP_Z_MAX = 0;
const AUTO_FIT_WORLD_BOUNDS = false;
const AUTO_FIT_PADDING_RATIO = 0.04;

/** Optional pixel nudges after world projection. */
const MAP_OFFSET_X_PX = 75;
const MAP_OFFSET_Y_PX = -15;
const MAP_SCALE_X = 1;
const MAP_SCALE_Y = 1;
const MAP_BG_SCALE_X = 0.803;
const MAP_BG_SCALE_Y = 0.966;
let runtimeOffsetXPx = MAP_OFFSET_X_PX;
let runtimeOffsetYPx = MAP_OFFSET_Y_PX;
let runtimeScaleX = MAP_SCALE_X;
let runtimeScaleY = MAP_SCALE_Y;
let runtimeBgScaleX = MAP_BG_SCALE_X;
let runtimeBgScaleY = MAP_BG_SCALE_Y;

/** Set true if the map appears vertically mirrored vs territories */
const FLIP_Z = true;

const RESOURCE_KEYS = ['emeralds', 'wood', 'ore', 'crops', 'fish'];
const HIGHLIGHT_COLORS = {
  emeralds: '#58ff66',
  wood: '#22c55e',
  ore: '#ef4444',
  crops: '#eab308',
  fish: '#38bdf8'
};

/** @type {{ static: object | null, live: object | null, mergedAt: number }} */
let cache = { static: null, live: null, mergedAt: 0 };

/**
 * Escape text for safe HTML insertion.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    if (ch === '&') return '&amp;';
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '"') return '&quot;';
    return '&#39;';
  });
}

/**
 * @param {string} name
 * @returns {string}
 */
function normalizeKey(name) {
  return String(name)
    .trim()
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'")
    .toLowerCase();
}

/**
 * @param {object} live
 * @returns {Map<string, string>}
 */
function buildLiveKeyMap(live) {
  /** @type {Map<string, string>} */
  const map = new Map();
  Object.keys(live).forEach(function (k) {
    map.set(normalizeKey(k), k);
  });
  return map;
}

/**
 * @param {object} row
 * @returns {{ start: number[], end: number[] } | null}
 */
function readLocation(row) {
  const loc = row.Location || row.location;
  if (!loc || !loc.start || !loc.end) return null;
  return { start: loc.start, end: loc.end };
}

/**
 * @param {object} row
 * @returns {string[]}
 */
function readTradeRoutes(row) {
  const tr = row['Trading Routes'] || row.tradingRoutes || row.trade_routes;
  return Array.isArray(tr) ? tr.map(String) : [];
}

/**
 * @param {object} row
 * @returns {ResourceSet}
 */
function readResources(row) {
  const res = row.resources || {};
  /** @type {ResourceSet} */
  const out = {};
  RESOURCE_KEYS.forEach(function (k) {
    const v = res[k];
    out[k] = v != null ? String(v) : '0';
  });
  return out;
}

/**
 * @param {ResourceSet} res
 * @returns {{ emeralds: number, wood: number, ore: number, crops: number, fish: number, dominant: string, productionScore: number }}
 */
function parseResourceNumbers(res) {
  const nums = {
    emeralds: parseInt(res.emeralds || '0', 10) || 0,
    wood: parseInt(res.wood || '0', 10) || 0,
    ore: parseInt(res.ore || '0', 10) || 0,
    crops: parseInt(res.crops || '0', 10) || 0,
    fish: parseInt(res.fish || '0', 10) || 0
  };
  let dominant = 'emeralds';
  let max = nums.emeralds;
  ['wood', 'ore', 'crops', 'fish'].forEach(function (k) {
    if (nums[k] > max) {
      max = nums[k];
      dominant = k;
    }
  });
  if (
    nums.wood === nums.ore &&
    nums.ore === nums.crops &&
    nums.crops === nums.fish &&
    nums.fish === 0
  ) {
    dominant = 'emeralds';
  }
  const productionScore =
    nums.emeralds + nums.wood + nums.ore + nums.crops + nums.fish;
  return { ...nums, dominant, productionScore };
}

/**
 * @param {string} guildName
 * @returns {string}
 */
export function guildColor(guildName) {
  const label = guildName && String(guildName).trim() ? guildName : 'Unclaimed';
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return 'hsl(' + hue + ', 62%, 52%)';
}

/**
 * @param {object} staticData
 * @param {object} liveData
 * @returns {MergedTerritory[]}
 */
export function mergeTerritories(staticData, liveData) {
  const liveMap = buildLiveKeyMap(liveData);
  const names = new Set([
    ...Object.keys(staticData),
    ...Object.keys(liveData)
  ]);
  /** @type {MergedTerritory[]} */
  const list = [];
  names.forEach(function (name) {
    const sRow = staticData[name] || {};
    const liveKey = liveData[name] ? name : liveMap.get(normalizeKey(name));
    const lRow = liveKey ? liveData[liveKey] : null;
    const resources = readResources(Object.keys(sRow).length ? sRow : {});
    const tradeRoutes = readTradeRoutes(sRow);
    let guild = { uuid: '', name: '', prefix: '' };
    let acquired = '';
    let loc = readLocation(sRow);
    if (lRow) {
      if (lRow.guild) guild = { ...guild, ...lRow.guild };
      if (lRow.acquired) acquired = String(lRow.acquired);
      const liveLoc = readLocation(lRow);
      if (liveLoc) loc = liveLoc;
    }
    if (!loc) return;
    const x1 = loc.start[0];
    const z1 = loc.start[1];
    const x2 = loc.end[0];
    const z2 = loc.end[1];
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    const minZ = Math.min(z1, z2);
    const maxZ = Math.max(z1, z2);
    const parsed = parseResourceNumbers(resources);
    const ownerLabel =
      guild.name && guild.name.trim()
        ? guild.name + (guild.prefix ? ' [' + guild.prefix + ']' : '')
        : 'Unclaimed';
    list.push({
      name,
      resources,
      tradeRoutes,
      guild,
      acquired,
      minX,
      maxX,
      minZ,
      maxZ,
      emeralds: parsed.emeralds,
      wood: parsed.wood,
      ore: parsed.ore,
      crops: parsed.crops,
      fish: parsed.fish,
      dominant: parsed.dominant,
      productionScore: parsed.productionScore,
      ownerLabel
    });
  });
  list.sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });
  return list;
}

/**
 * @returns {Promise<object>}
 */
async function fetchStaticTerritories() {
  const res = await fetch(STATIC_TERRITORIES_URL);
  if (!res.ok) throw new Error('Static territory data failed (' + res.status + ')');
  return res.json();
}

/**
 * @returns {Promise<object>}
 */
async function fetchLiveTerritories() {
  const res = await fetch(LIVE_TERRITORIES_URL);
  if (!res.ok) throw new Error('Wynncraft territory API failed (' + res.status + ')');
  return res.json();
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

/**
 * Build world bounds from territory rectangles with optional padding.
 * @param {MergedTerritory[]} list
 * @returns {{ xMin: number, xMax: number, zMin: number, zMax: number } | null}
 */
function worldBoundsFromTerritories(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let xMin = Infinity;
  let xMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  list.forEach(function (t) {
    xMin = Math.min(xMin, t.minX);
    xMax = Math.max(xMax, t.maxX);
    zMin = Math.min(zMin, t.minZ);
    zMax = Math.max(zMax, t.maxZ);
  });
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || !Number.isFinite(zMin) || !Number.isFinite(zMax)) {
    return null;
  }
  const xSpan = Math.max(1, xMax - xMin);
  const zSpan = Math.max(1, zMax - zMin);
  const xPad = Math.round(xSpan * AUTO_FIT_PADDING_RATIO);
  const zPad = Math.round(zSpan * AUTO_FIT_PADDING_RATIO);
  return {
    xMin: xMin - xPad,
    xMax: xMax + xPad,
    zMin: zMin - zPad,
    zMax: zMax + zPad
  };
}

/**
 * @param {number} x
 * @param {number} z
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} zMin
 * @param {number} zMax
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object} Leaflet LatLng
 */
function worldToLayer(x, z, xMin, xMax, zMin, zMax, imgW, imgH) {
  const westSpan = Math.abs(xMin) || 1;
  const eastSpan = Math.abs(xMax) || 1;
  const northSpan = Math.abs(zMin) || 1;
  const southSpan = Math.abs(zMax) || 1;

  let nx;
  if (x < 0) {
    nx = 0.5 - 0.5 * (Math.abs(x) / westSpan);
  } else {
    nx = 0.5 + 0.5 * (Math.abs(x) / eastSpan);
  }

  let ny;
  if (z <= 0) {
    ny = 1 - (Math.abs(z) / northSpan);
  } else {
    ny = 1 + (Math.abs(z) / southSpan);
  }

  nx = clamp01(nx);
  ny = clamp01(ny);
  if (FLIP_Z) ny = 1 - ny;
  const scaledNx = 0.5 + (nx - 0.5) * runtimeScaleX;
  const scaledNy = 0.5 + (ny - 0.5) * runtimeScaleY;
  return L.latLng(
    scaledNy * imgH + runtimeOffsetYPx,
    scaledNx * imgW + runtimeOffsetXPx
  );
}

/**
 * @param {number} minX
 * @param {number} maxX
 * @param {number} minZ
 * @param {number} maxZ
 * @param {number} xMin
 * @param {number} xMax
 * @param {number} zMin
 * @param {number} zMax
 * @param {number} imgW
 * @param {number} imgH
 * @returns {object} Leaflet LatLngBounds
 */
function boundsFromWorldRect(
  minX,
  maxX,
  minZ,
  maxZ,
  xMin,
  xMax,
  zMin,
  zMax,
  imgW,
  imgH
) {
  const corners = [
    worldToLayer(minX, minZ, xMin, xMax, zMin, zMax, imgW, imgH),
    worldToLayer(maxX, minZ, xMin, xMax, zMin, zMax, imgW, imgH),
    worldToLayer(maxX, maxZ, xMin, xMax, zMin, zMax, imgW, imgH),
    worldToLayer(minX, maxZ, xMin, xMax, zMin, zMax, imgW, imgH)
  ];
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  corners.forEach(function (c) {
    minLat = Math.min(minLat, c.lat);
    maxLat = Math.max(maxLat, c.lat);
    minLng = Math.min(minLng, c.lng);
    maxLng = Math.max(maxLng, c.lng);
  });
  return L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
}

/**
 * @param {MergedTerritory} t
 * @param {{ xMin: number, xMax: number, zMin: number, zMax: number, imgW: number, imgH: number }} geo
 * @returns {object} Leaflet LatLng
 */
function territoryCenter(t, geo) {
  const cx = (t.minX + t.maxX) / 2;
  const cz = (t.minZ + t.maxZ) / 2;
  return worldToLayer(cx, cz, geo.xMin, geo.xMax, geo.zMin, geo.zMax, geo.imgW, geo.imgH);
}

/**
 * @param {MergedTerritory} t
 * @param {string | null} filterResource
 * @param {string} guildFilter
 * @param {number} emeraldMin
 * @param {string} specialFilter
 * @returns {boolean}
 */
function passesFilters(t, filterResource, guildFilter, emeraldMin, specialFilter) {
  if (guildFilter && t.guild.name !== guildFilter) return false;
  if (t.emeralds < emeraldMin) return false;
  if (specialFilter === 'oasis' && !t.name.toLowerCase().includes('oasis')) return false;
  if (specialFilter === 'rainbow' && !t.name.toLowerCase().includes('rainbow'))
    return false;
  if (filterResource && t.dominant !== filterResource) return false;
  return true;
}

/**
 * Initialize territory map UI and Leaflet map.
 * @returns {Promise<void>}
 */
export async function initTerritoryMap() {
  if (typeof L === 'undefined') {
    console.error('Leaflet not loaded');
    return;
  }

  const statusBanner = document.getElementById('statusBanner');
  const mergedMeta = document.getElementById('mergedMeta');
  const refreshBtn = document.getElementById('refreshBtn');
  const searchInput = document.getElementById('searchInput');
  const resourceFilter = document.getElementById('resourceFilter');
  const guildFilter = document.getElementById('guildFilter');
  const emeraldMinInput = document.getElementById('emeraldMinInput');
  const specialFilter = document.getElementById('specialFilter');
  const toggleRoutes = document.getElementById('toggleRoutes');
  const toggleHeatmap = document.getElementById('toggleHeatmap');
  const toggleSimulate = document.getElementById('toggleSimulate');
  const simulatePanel = document.getElementById('simulatePanel');
  const simulateTotals = document.getElementById('simulateTotals');
  const clearSimulateBtn = document.getElementById('clearSimulateBtn');
  const tableBody = document.getElementById('territoryTableBody');
  const territoryModal = document.getElementById('territoryModal');
  const modalTitle = document.getElementById('modalTitle');
  const modalBody = document.getElementById('modalBody');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const sidebar = document.getElementById('territorySidebar');
  const sidebarToggle = document.getElementById('sidebarToggle');
  const calOffsetX = document.getElementById('calOffsetX');
  const calOffsetY = document.getElementById('calOffsetY');
  const calOffsetXValue = document.getElementById('calOffsetXValue');
  const calOffsetYValue = document.getElementById('calOffsetYValue');
  const calNudgeLeft = document.getElementById('calNudgeLeft');
  const calNudgeRight = document.getElementById('calNudgeRight');
  const calNudgeUp = document.getElementById('calNudgeUp');
  const calNudgeDown = document.getElementById('calNudgeDown');
  const calDragToggle = document.getElementById('calDragToggle');
  const calReset = document.getElementById('calReset');
  const calCopy = document.getElementById('calCopy');
  const calOutput = document.getElementById('calOutput');
  const calAutoFitBounds = document.getElementById('calAutoFitBounds');
  const calScaleX = document.getElementById('calScaleX');
  const calScaleY = document.getElementById('calScaleY');
  const calScaleXValue = document.getElementById('calScaleXValue');
  const calScaleYValue = document.getElementById('calScaleYValue');
  const calBgScaleX = document.getElementById('calBgScaleX');
  const calBgScaleY = document.getElementById('calBgScaleY');
  const calBgScaleXValue = document.getElementById('calBgScaleXValue');
  const calBgScaleYValue = document.getElementById('calBgScaleYValue');
  const calTerritoryName = document.getElementById('calTerritoryName');
  const calTerrScaleX = document.getElementById('calTerrScaleX');
  const calTerrScaleY = document.getElementById('calTerrScaleY');
  const calTerrScaleXValue = document.getElementById('calTerrScaleXValue');
  const calTerrScaleYValue = document.getElementById('calTerrScaleYValue');
  const calTerrScaleReset = document.getElementById('calTerrScaleReset');
  const calTerrOffsetX = document.getElementById('calTerrOffsetX');
  const calTerrOffsetY = document.getElementById('calTerrOffsetY');
  const calTerrOffsetXValue = document.getElementById('calTerrOffsetXValue');
  const calTerrOffsetYValue = document.getElementById('calTerrOffsetYValue');
  const calMultiSelect = document.getElementById('calMultiSelect');
  const calSelectionClear = document.getElementById('calSelectionClear');

  /** @type {{ xMin: number, xMax: number, zMin: number, zMax: number, imgW: number, imgH: number } | null} */
  let geo = null;
  /** @type {object | null} */
  let map = null;
  /** @type {object | null} */
  let imageOverlay = null;
  /** @type {object} */
  const territoryGroup = L.featureGroup();
  /** @type {object} */
  const routeLayer = L.layerGroup();
  /** @type {Map<string, object>} */
  const layersByName = new Map();
  /** @type {MergedTerritory[]} */
  let mergedList = [];
  /** @type {Set<string>} */
  const simulateSelected = new Set();
  let sortKey = 'name';
  let sortDir = 1;
  let useAutoFitBounds = AUTO_FIT_WORLD_BOUNDS;
  let dragTerritoriesEnabled = false;
  let isDraggingTerritories = false;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragStartOffsetX = 0;
  let dragStartOffsetY = 0;
  let multiSelectEnabled = false;
  /** @type {Set<string>} */
  const selectedTerritoryNames = new Set();
  /** @type {Map<string, { scaleX: number, scaleY: number, offsetX: number, offsetY: number }>} */
  const territoryTransformByName = new Map();

  function getPrimarySelectedTerritory() {
    const first = selectedTerritoryNames.values().next();
    return first.done ? '' : first.value;
  }

  function getSelectedTerritoriesLabel() {
    if (selectedTerritoryNames.size === 0) return 'None';
    const all = Array.from(selectedTerritoryNames);
    if (all.length <= 3) return all.join(', ');
    return all.slice(0, 3).join(', ') + ' +' + (all.length - 3) + ' more';
  }

  function getTerritoryTransform(name) {
    if (!name || !territoryTransformByName.has(name)) {
      return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
    }
    const t = territoryTransformByName.get(name);
    return {
      scaleX: Number.isFinite(t && t.scaleX) ? t.scaleX : 1,
      scaleY: Number.isFinite(t && t.scaleY) ? t.scaleY : 1,
      offsetX: Number.isFinite(t && t.offsetX) ? t.offsetX : 0,
      offsetY: Number.isFinite(t && t.offsetY) ? t.offsetY : 0
    };
  }

  function getSelectionTransformBaseline() {
    return getTerritoryTransform(getPrimarySelectedTerritory());
  }

  function getScaledTerritoryRect(t) {
    const transform = getTerritoryTransform(t.name);
    const cx = (t.minX + t.maxX) / 2;
    const cz = (t.minZ + t.maxZ) / 2;
    const halfW = ((t.maxX - t.minX) / 2) * transform.scaleX;
    const halfH = ((t.maxZ - t.minZ) / 2) * transform.scaleY;
    return {
      minX: cx - halfW,
      maxX: cx + halfW,
      minZ: cz - halfH,
      maxZ: cz + halfH
    };
  }

  function applyTerritoryOffset(bounds, territoryName) {
    const transform = getTerritoryTransform(territoryName);
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    return L.latLngBounds(
      [sw.lat + transform.offsetY, sw.lng + transform.offsetX],
      [ne.lat + transform.offsetY, ne.lng + transform.offsetX]
    );
  }

  function updateTerritorySelection(name, additive) {
    if (!name) return;
    if (additive) {
      if (selectedTerritoryNames.has(name)) selectedTerritoryNames.delete(name);
      else selectedTerritoryNames.add(name);
    } else {
      selectedTerritoryNames.clear();
      selectedTerritoryNames.add(name);
    }
    updateCalibrationReadout();
    applyLayerStyles();
  }

  function applyTransformToSelection(mutator) {
    selectedTerritoryNames.forEach(function (name) {
      const current = getTerritoryTransform(name);
      const next = mutator(current);
      territoryTransformByName.set(name, {
        scaleX: Number.isFinite(next.scaleX) ? next.scaleX : 1,
        scaleY: Number.isFinite(next.scaleY) ? next.scaleY : 1,
        offsetX: Number.isFinite(next.offsetX) ? next.offsetX : 0,
        offsetY: Number.isFinite(next.offsetY) ? next.offsetY : 0
      });
    });
  }

  function findTerritoryByName(name) {
    return mergedList.find(function (t) {
      return t.name === name;
    }) || null;
  }

  function applyScaleSpacingToSelection(scaleX, scaleY) {
    if (!geo || selectedTerritoryNames.size === 0) return;
    const selected = Array.from(selectedTerritoryNames);
    const primaryName = getPrimarySelectedTerritory();
    const primaryTransform = getTerritoryTransform(primaryName);
    const centers = new Map();
    let sumLng = 0;
    let sumLat = 0;
    selected.forEach(function (name) {
      const t = findTerritoryByName(name);
      if (!t) return;
      const center = territoryCenter(t, geo);
      centers.set(name, center);
      sumLng += center.lng;
      sumLat += center.lat;
    });
    const count = Math.max(1, centers.size);
    const centerLng = sumLng / count;
    const centerLat = sumLat / count;
    selected.forEach(function (name) {
      const c = centers.get(name);
      const dx = c ? c.lng - centerLng : 0;
      const dy = c ? c.lat - centerLat : 0;
      const spreadX = count > 1 ? dx * (scaleX - 1) : 0;
      const spreadY = count > 1 ? dy * (scaleY - 1) : 0;
      territoryTransformByName.set(name, {
        scaleX,
        scaleY,
        offsetX: primaryTransform.offsetX + spreadX,
        offsetY: primaryTransform.offsetY + spreadY
      });
    });
  }

  function setStatus(kind, message) {
    if (!statusBanner) return;
    statusBanner.classList.remove('hidden', 'bg-red-900/40', 'text-red-200', 'bg-amber-900/30', 'text-amber-100', 'bg-slate-800/80', 'text-gray-300');
    if (!message) {
      statusBanner.classList.add('hidden');
      statusBanner.textContent = '';
      return;
    }
    statusBanner.classList.remove('hidden');
    statusBanner.textContent = message;
    if (kind === 'error') {
      statusBanner.classList.add('bg-red-900/40', 'text-red-200');
    } else if (kind === 'warn') {
      statusBanner.classList.add('bg-amber-900/30', 'text-amber-100');
    } else {
      statusBanner.classList.add('bg-slate-800/80', 'text-gray-300');
    }
  }

  async function loadData(force) {
    setStatus('info', 'Loading territory data…');
    try {
      let staticData = cache.static;
      let liveData = cache.live;
      if (force || !staticData || !liveData) {
        const [s, l] = await Promise.all([
          fetchStaticTerritories(),
          fetchLiveTerritories()
        ]);
        staticData = s;
        liveData = l;
        cache = { static: s, live: l, mergedAt: Date.now() };
      }
      mergedList = mergeTerritories(staticData, liveData);
      if (mergedMeta) {
        mergedMeta.textContent =
          mergedList.length +
          ' territories · updated ' +
          new Date(cache.mergedAt).toLocaleTimeString();
      }
      setStatus('', '');
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load data';
      setStatus('error', msg + ' — Retry or check network / API limits.');
      return false;
    }
  }

  function rebuildGuildOptions() {
    if (!guildFilter) return;
    const owners = new Set();
    mergedList.forEach(function (t) {
      if (t.guild.name) owners.add(t.guild.name);
    });
    const sorted = [...owners].sort();
    while (guildFilter.options.length > 1) {
      guildFilter.remove(1);
    }
    sorted.forEach(function (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      guildFilter.appendChild(opt);
    });
  }

  function getFilterState() {
    return {
      q: (searchInput && searchInput.value) ? searchInput.value.trim().toLowerCase() : '',
      resource: (resourceFilter && resourceFilter.value) || '',
      guild: (guildFilter && guildFilter.value) || '',
      emeraldMin:
        emeraldMinInput && emeraldMinInput.value
          ? parseInt(emeraldMinInput.value, 10) || 0
          : 0,
      special: (specialFilter && specialFilter.value) || '',
      heatmap: toggleHeatmap && toggleHeatmap.checked,
      routes: toggleRoutes && toggleRoutes.checked,
      simulate: toggleSimulate && toggleSimulate.checked
    };
  }

  function styleForTerritory(t, fs, maxScore) {
    const baseColor = guildColor(t.ownerLabel === 'Unclaimed' ? '' : t.guild.name);
    let fillOpacity = 0.34;
    let color = baseColor;
    let weight = 1;
    if (simulateSelected.has(t.name)) {
      weight = 3;
      color = '#facc15';
    }
    if (selectedTerritoryNames.has(t.name)) {
      weight = Math.max(weight, 3);
      color = '#2ce8ff';
      fillOpacity = Math.max(fillOpacity, 0.32);
    }
    if (fs.heatmap) {
      const ratio = maxScore > 0 ? t.productionScore / maxScore : 0;
      fillOpacity = 0.15 + ratio * 0.55;
      const hue = 270 - ratio * 220;
      color = 'hsl(' + hue + ', 70%, 50%)';
    }
    let muted = false;
    if (!passesFilters(t, fs.resource || null, fs.guild, fs.emeraldMin, fs.special)) {
      muted = true;
    }
    if (fs.q && !t.name.toLowerCase().includes(fs.q)) muted = true;
    if (muted) {
      return {
        color: '#444',
        weight: 1,
        fillColor: '#1a1a22',
        fillOpacity: 0.12,
        opacity: 0.35
      };
    }
    if (fs.resource && HIGHLIGHT_COLORS[fs.resource]) {
      color = HIGHLIGHT_COLORS[fs.resource];
      fillOpacity = Math.max(fillOpacity, 0.35);
    }
    return {
      color: color,
      weight: weight,
      fillColor: fs.heatmap ? color : baseColor,
      fillOpacity: fillOpacity,
      opacity: 0.9
    };
  }

  function applyLayerStyles() {
    const fs = getFilterState();
    let maxScore = 0;
    mergedList.forEach(function (t) {
      if (t.productionScore > maxScore) maxScore = t.productionScore;
    });
    mergedList.forEach(function (t) {
      const layer = layersByName.get(t.name);
      if (layer) layer.setStyle(styleForTerritory(t, fs, maxScore));
    });
  }

  function rebuildRoutes() {
    routeLayer.clearLayers();
    if (!geo || !toggleRoutes || !toggleRoutes.checked) return;
    const centers = new Map();
    mergedList.forEach(function (t) {
      centers.set(t.name, territoryCenter(t, geo));
    });
    const drawn = new Set();
    mergedList.forEach(function (t) {
      t.tradeRoutes.forEach(function (otherName) {
        const a = t.name;
        const b = otherName;
        if (!centers.has(b)) return;
        const key = a < b ? a + '|' + b : b + '|' + a;
        if (drawn.has(key)) return;
        drawn.add(key);
        const latlngs = [centers.get(a), centers.get(b)];
        L.polyline(latlngs, {
          color: 'rgba(255,255,255,0.85)',
          weight: 1.4
        }).addTo(routeLayer);
      });
    });
  }

  function updateSimulatePanel() {
    if (!simulateTotals) return;
    if (!toggleSimulate || !toggleSimulate.checked) {
      simulateTotals.textContent = 'Enable simulate mode to select territories.';
      return;
    }
    if (simulateSelected.size === 0) {
      simulateTotals.textContent = 'None selected.';
      return;
    }
    let em = 0;
    let w = 0;
    let o = 0;
    let c = 0;
    let f = 0;
    mergedList.forEach(function (t) {
      if (!simulateSelected.has(t.name)) return;
      em += t.emeralds;
      w += t.wood;
      o += t.ore;
      c += t.crops;
      f += t.fish;
    });
    simulateTotals.innerHTML =
      '<ul class="list-disc pl-4 space-y-0.5">' +
      '<li>Emeralds / hr: ' +
      em +
      '</li>' +
      '<li>Wood / hr: ' +
      w +
      '</li>' +
      '<li>Ore / hr: ' +
      o +
      '</li>' +
      '<li>Crops / hr: ' +
      c +
      '</li>' +
      '<li>Fish / hr: ' +
      f +
      '</li>' +
      '<li class="text-gray-400">Selected: ' +
      simulateSelected.size +
      '</li>' +
      '</ul>';
  }

  function openModal(t) {
    if (!territoryModal || !modalTitle || !modalBody) return;
    modalTitle.textContent = t.name;
    const gc =
      t.ownerLabel === 'Unclaimed' ? '#6b7280' : guildColor(t.guild.name);
    const acq = t.acquired
      ? new Date(t.acquired).toLocaleString()
      : '—';
    const routes =
      t.tradeRoutes.length > 0
        ? '<ul class="list-disc pl-5 space-y-1">' +
          t.tradeRoutes.map(function (r) {
            return '<li>' + escapeHtml(r) + '</li>';
          }).join('') +
          '</ul>'
        : '<p class="text-gray-500">None listed</p>';
    modalBody.innerHTML =
      '<div class="flex items-center gap-2">' +
      '<span class="inline-block w-4 h-4 rounded-full shrink-0" style="background:' +
      escapeHtml(gc) +
      '"></span>' +
      '<span class="font-medium">' +
      escapeHtml(t.ownerLabel) +
      '</span>' +
      '</div>' +
      '<p class="text-gray-400">Acquired: ' +
      escapeHtml(acq) +
      '</p>' +
      '<div class="grid grid-cols-2 gap-2 text-sm">' +
      '<div>Emeralds / hr<br><span class="font-semibold text-white">' +
      t.emeralds +
      '</span></div>' +
      '<div>Wood / hr<br><span class="font-semibold text-white">' +
      t.wood +
      '</span></div>' +
      '<div>Ore / hr<br><span class="font-semibold text-white">' +
      t.ore +
      '</span></div>' +
      '<div>Crops / hr<br><span class="font-semibold text-white">' +
      t.crops +
      '</span></div>' +
      '<div>Fish / hr<br><span class="font-semibold text-white">' +
      t.fish +
      '</span></div>' +
      '<div>Dominant<br><span class="font-semibold text-white">' +
      escapeHtml(t.dominant) +
      '</span></div>' +
      '</div>' +
      '<div><div class="text-gray-400 text-xs uppercase tracking-wide mb-1">Trade routes</div>' +
      routes +
      '</div>';
    if (typeof territoryModal.showModal === 'function') {
      territoryModal.showModal();
    }
  }

  function flyToTerritory(t) {
    if (!map || !geo) return;
    const rect = getScaledTerritoryRect(t);
    const worldBounds = boundsFromWorldRect(
      rect.minX,
      rect.maxX,
      rect.minZ,
      rect.maxZ,
      geo.xMin,
      geo.xMax,
      geo.zMin,
      geo.zMax,
      geo.imgW,
      geo.imgH
    );
    const b = applyTerritoryOffset(worldBounds, t.name);
    map.fitBounds(b, { padding: [24, 24], maxZoom: 5, animate: true });
  }

  function attachLayerClick(layer, t) {
    layer.on('click', function (ev) {
      const additive = !!(multiSelectEnabled || (ev.originalEvent && ev.originalEvent.shiftKey));
      updateTerritorySelection(t.name, additive);
      const fs = getFilterState();
      if (fs.simulate) {
        L.DomEvent.stopPropagation(ev);
        if (simulateSelected.has(t.name)) simulateSelected.delete(t.name);
        else simulateSelected.add(t.name);
        applyLayerStyles();
        updateSimulatePanel();
        return;
      }
      openModal(t);
    });
  }

  function rebuildTerritoryLayers() {
    if (!geo) return;
    territoryGroup.clearLayers();
    layersByName.clear();
    const fs0 = getFilterState();
    mergedList.forEach(function (t) {
      const rect = getScaledTerritoryRect(t);
      const worldBounds = boundsFromWorldRect(
        rect.minX,
        rect.maxX,
        rect.minZ,
        rect.maxZ,
        geo.xMin,
        geo.xMax,
        geo.zMin,
        geo.zMax,
        geo.imgW,
        geo.imgH
      );
      const rectBounds = applyTerritoryOffset(worldBounds, t.name);
      const layer = L.rectangle(rectBounds, styleForTerritory(t, fs0, 1));
      attachLayerClick(layer, t);
      layer.bindTooltip(t.name, { sticky: true, direction: 'auto', className: 'territory-tip' });
      territoryGroup.addLayer(layer);
      layersByName.set(t.name, layer);
    });
    applyLayerStyles();
    rebuildRoutes();
  }

  function renderTable() {
    if (!tableBody) return;
    const fs = getFilterState();
    let rows = mergedList.filter(function (t) {
      if (fs.q && !t.name.toLowerCase().includes(fs.q)) return false;
      return passesFilters(
        t,
        fs.resource || null,
        fs.guild,
        fs.emeraldMin,
        fs.special
      );
    });
    rows = rows.slice().sort(function (a, b) {
      let va = sortKey === 'owner' ? a.ownerLabel : a[sortKey];
      let vb = sortKey === 'owner' ? b.ownerLabel : b[sortKey];
      if (typeof va === 'string') {
        return sortDir * String(va).localeCompare(String(vb));
      }
      if (va < vb) return -sortDir;
      if (va > vb) return sortDir;
      return 0;
    });
    tableBody.innerHTML = rows
      .map(function (t) {
        const ownerShort =
          t.guild.prefix || (t.guild.name ? t.guild.name.slice(0, 6) : '—');
        return (
          '<tr class="border-b border-[rgba(40,40,48,0.6)] hover:bg-[rgba(80,60,120,0.15)] cursor-pointer" data-name="' +
          escapeHtml(t.name) +
          '">' +
          '<td class="px-2 py-1.5 max-w-[8rem] truncate" title="' +
          escapeHtml(t.name) +
          '">' +
          escapeHtml(t.name) +
          '</td>' +
          '<td class="px-2 py-1.5 text-right tabular-nums">' +
          t.emeralds +
          '</td>' +
          '<td class="px-2 py-1.5 text-right tabular-nums hidden sm:table-cell">' +
          t.wood +
          '</td>' +
          '<td class="px-2 py-1.5 text-right tabular-nums hidden sm:table-cell">' +
          t.ore +
          '</td>' +
          '<td class="px-2 py-1.5 text-right tabular-nums hidden md:table-cell">' +
          t.crops +
          '</td>' +
          '<td class="px-2 py-1.5 text-right tabular-nums hidden md:table-cell">' +
          t.fish +
          '</td>' +
          '<td class="px-2 py-1.5 truncate max-w-[4rem]" title="' +
          escapeHtml(t.ownerLabel) +
          '">' +
          escapeHtml(ownerShort) +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  function updateCalibrationReadout() {
    if (calOffsetXValue) calOffsetXValue.textContent = String(runtimeOffsetXPx);
    if (calOffsetYValue) calOffsetYValue.textContent = String(runtimeOffsetYPx);
    const selectedTransform = getSelectionTransformBaseline();
    const hasSelection = selectedTerritoryNames.size > 0;
    if (calOutput) {
      calOutput.textContent =
        'MAP_OFFSET_X_PX = ' +
        runtimeOffsetXPx +
        ', MAP_OFFSET_Y_PX = ' +
        runtimeOffsetYPx +
        ', MAP_SCALE_X = ' +
        runtimeScaleX.toFixed(3) +
        ', MAP_SCALE_Y = ' +
        runtimeScaleY.toFixed(3) +
        ', MAP_BG_SCALE_X = ' +
        runtimeBgScaleX.toFixed(3) +
        ', MAP_BG_SCALE_Y = ' +
        runtimeBgScaleY.toFixed(3) +
        ', SELECTED = ' +
        selectedTerritoryNames.size +
        ', SEL_MOVE_X = ' +
        selectedTransform.offsetX +
        ', SEL_MOVE_Y = ' +
        selectedTransform.offsetY +
        ', SEL_SCALE_X = ' +
        selectedTransform.scaleX.toFixed(3) +
        ', SEL_SCALE_Y = ' +
        selectedTransform.scaleY.toFixed(3) +
        ', BOUNDS = ' +
        (useAutoFitBounds ? 'AUTO' : 'FIXED');
    }
    if (calOffsetX) calOffsetX.value = String(runtimeOffsetXPx);
    if (calOffsetY) calOffsetY.value = String(runtimeOffsetYPx);
    if (calScaleXValue) calScaleXValue.textContent = runtimeScaleX.toFixed(3);
    if (calScaleYValue) calScaleYValue.textContent = runtimeScaleY.toFixed(3);
    if (calScaleX) calScaleX.value = String(Math.round(runtimeScaleX * 1000));
    if (calScaleY) calScaleY.value = String(Math.round(runtimeScaleY * 1000));
    if (calBgScaleXValue) calBgScaleXValue.textContent = runtimeBgScaleX.toFixed(3);
    if (calBgScaleYValue) calBgScaleYValue.textContent = runtimeBgScaleY.toFixed(3);
    if (calBgScaleX) calBgScaleX.value = String(Math.round(runtimeBgScaleX * 1000));
    if (calBgScaleY) calBgScaleY.value = String(Math.round(runtimeBgScaleY * 1000));
    if (calTerritoryName) calTerritoryName.textContent = getSelectedTerritoriesLabel();
    if (calTerrOffsetXValue) calTerrOffsetXValue.textContent = String(selectedTransform.offsetX);
    if (calTerrOffsetYValue) calTerrOffsetYValue.textContent = String(selectedTransform.offsetY);
    if (calTerrScaleXValue) calTerrScaleXValue.textContent = selectedTransform.scaleX.toFixed(3);
    if (calTerrScaleYValue) calTerrScaleYValue.textContent = selectedTransform.scaleY.toFixed(3);
    if (calTerrOffsetX) {
      calTerrOffsetX.value = String(Math.round(selectedTransform.offsetX));
      calTerrOffsetX.disabled = !hasSelection;
    }
    if (calTerrOffsetY) {
      calTerrOffsetY.value = String(Math.round(selectedTransform.offsetY));
      calTerrOffsetY.disabled = !hasSelection;
    }
    if (calTerrScaleX) {
      calTerrScaleX.value = String(Math.round(selectedTransform.scaleX * 1000));
      calTerrScaleX.disabled = !hasSelection;
    }
    if (calTerrScaleY) {
      calTerrScaleY.value = String(Math.round(selectedTransform.scaleY * 1000));
      calTerrScaleY.disabled = !hasSelection;
    }
    if (calTerrScaleReset) calTerrScaleReset.disabled = !hasSelection;
    if (calSelectionClear) calSelectionClear.disabled = !hasSelection;
    if (calMultiSelect) calMultiSelect.checked = multiSelectEnabled;
  }

  function applyCalibrationOffset() {
    if (!geo) return;
    rebuildTerritoryLayers();
  }

  function refreshDragToggleUi() {
    if (!calDragToggle) return;
    calDragToggle.textContent = dragTerritoriesEnabled
      ? 'Drag territories: On'
      : 'Drag territories: Off';
    calDragToggle.classList.toggle('theme-btn-primary', dragTerritoriesEnabled);
  }

  /**
   * @param {number} imgW
   * @param {number} imgH
   * @returns {object} Leaflet LatLngBounds
   */
  function getImageOverlayBounds(imgW, imgH) {
    const scaledW = imgW * runtimeBgScaleX;
    const scaledH = imgH * runtimeBgScaleY;
    const minLng = (imgW - scaledW) / 2;
    const maxLng = minLng + scaledW;
    const minLat = (imgH - scaledH) / 2;
    const maxLat = minLat + scaledH;
    return L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
  }

  function applyBackgroundScale() {
    if (!map || !imageOverlay || !geo) return;
    imageOverlay.setBounds(getImageOverlayBounds(geo.imgW, geo.imgH));
  }

  /**
   * @returns {{ xMin: number, xMax: number, zMin: number, zMax: number }}
   */
  function resolveWorldBounds() {
    const fitted = useAutoFitBounds ? worldBoundsFromTerritories(mergedList) : null;
    if (fitted) return fitted;
    return {
      xMin: MAP_X_MIN,
      xMax: MAP_X_MAX,
      zMin: MAP_Z_MIN,
      zMax: MAP_Z_MAX
    };
  }

  async function setupMap() {
    const img = new Image();
    img.src = MAP_IMAGE_URL;
    await new Promise(function (resolve, reject) {
      img.onload = function () {
        resolve();
      };
      img.onerror = function () {
        reject(new Error('Map image missing. Add main-map.webp next to index.html.'));
      };
    });
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const resolved = resolveWorldBounds();
    const xMin = resolved.xMin;
    const xMax = resolved.xMax;
    const zMin = resolved.zMin;
    const zMax = resolved.zMax;
    if (
      !Number.isFinite(xMin) ||
      !Number.isFinite(xMax) ||
      !Number.isFinite(zMin) ||
      !Number.isFinite(zMax)
    ) {
      throw new Error('Invalid fixed MAP_* bounds. Set numeric MAP_X_MIN/MAX and MAP_Z_MIN/MAX.');
    }
    geo = { xMin, xMax, zMin, zMax, imgW, imgH };
    const bounds = L.latLngBounds([[0, 0], [imgH, imgW]]);
    const overlayBounds = getImageOverlayBounds(imgW, imgH);
    map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      zoomSnap: 0.25,
      attributionControl: false
    });
    imageOverlay = L.imageOverlay(MAP_IMAGE_URL, overlayBounds).addTo(map);
    map.fitBounds(bounds);
    territoryGroup.addTo(map);
    routeLayer.addTo(map);
    rebuildTerritoryLayers();
  }

  document.querySelectorAll('th.sortable').forEach(function (th) {
    th.addEventListener('click', function () {
      const key = th.getAttribute('data-sort');
      if (!key) return;
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = 1;
      }
      renderTable();
    });
  });

  if (tableBody) {
    tableBody.addEventListener('click', function (ev) {
      const tr = ev.target && ev.target.closest('tr');
      if (!tr || !tr.dataset.name) return;
      const t = mergedList.find(function (m) {
        return m.name === tr.dataset.name;
      });
      if (!t) return;
      const additive = !!(multiSelectEnabled || ev.shiftKey);
      updateTerritorySelection(t.name, additive);
      flyToTerritory(t);
      if (toggleSimulate && toggleSimulate.checked) {
        if (simulateSelected.has(t.name)) simulateSelected.delete(t.name);
        else simulateSelected.add(t.name);
        applyLayerStyles();
        updateSimulatePanel();
        return;
      }
      openModal(t);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', async function () {
      const ok = await loadData(true);
      if (!ok || !map) return;
      rebuildGuildOptions();
      rebuildTerritoryLayers();
      renderTable();
    });
  }

  [
    searchInput,
    resourceFilter,
    guildFilter,
    emeraldMinInput,
    specialFilter,
    toggleHeatmap,
    toggleRoutes
  ].forEach(function (el) {
    if (el) {
      el.addEventListener('input', function () {
        renderTable();
        applyLayerStyles();
      });
      el.addEventListener('change', function () {
        renderTable();
        applyLayerStyles();
        if (el === toggleRoutes) rebuildRoutes();
      });
    }
  });

  if (toggleSimulate) {
    toggleSimulate.addEventListener('change', function () {
      if (simulatePanel) {
        simulatePanel.classList.toggle('hidden', !toggleSimulate.checked);
      }
      if (!toggleSimulate.checked) simulateSelected.clear();
      applyLayerStyles();
      updateSimulatePanel();
    });
  }

  if (clearSimulateBtn) {
    clearSimulateBtn.addEventListener('click', function () {
      simulateSelected.clear();
      applyLayerStyles();
      updateSimulatePanel();
    });
  }

  if (modalCloseBtn && territoryModal) {
    modalCloseBtn.addEventListener('click', function () {
      territoryModal.close();
    });
  }

  if (territoryModal) {
    territoryModal.addEventListener('click', function (ev) {
      if (ev.target === territoryModal) territoryModal.close();
    });
  }

  if (sidebarToggle && sidebar) {
    sidebarToggle.addEventListener('click', function () {
      sidebar.classList.toggle('hidden');
      sidebar.classList.toggle('flex');
      sidebar.classList.toggle('flex-col');
    });
  }

  updateCalibrationReadout();
  if (calAutoFitBounds) calAutoFitBounds.checked = useAutoFitBounds;

  if (calOffsetX) {
    calOffsetX.addEventListener('input', function () {
      runtimeOffsetXPx = parseInt(calOffsetX.value, 10) || 0;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calOffsetY) {
    calOffsetY.addEventListener('input', function () {
      runtimeOffsetYPx = parseInt(calOffsetY.value, 10) || 0;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calNudgeLeft) {
    calNudgeLeft.addEventListener('click', function () {
      runtimeOffsetXPx -= 1;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calNudgeRight) {
    calNudgeRight.addEventListener('click', function () {
      runtimeOffsetXPx += 1;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calNudgeUp) {
    calNudgeUp.addEventListener('click', function () {
      runtimeOffsetYPx -= 1;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calNudgeDown) {
    calNudgeDown.addEventListener('click', function () {
      runtimeOffsetYPx += 1;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calDragToggle) {
    calDragToggle.addEventListener('click', function () {
      dragTerritoriesEnabled = !dragTerritoriesEnabled;
      refreshDragToggleUi();
      if (!dragTerritoriesEnabled && map) {
        map.dragging.enable();
      }
      setStatus(
        'info',
        dragTerritoriesEnabled
          ? 'Drag mode on: drag on map to move territory overlay.'
          : 'Drag mode off.'
      );
    });
  }

  if (calReset) {
    calReset.addEventListener('click', function () {
      runtimeOffsetXPx = MAP_OFFSET_X_PX;
      runtimeOffsetYPx = MAP_OFFSET_Y_PX;
      runtimeScaleX = MAP_SCALE_X;
      runtimeScaleY = MAP_SCALE_Y;
      runtimeBgScaleX = MAP_BG_SCALE_X;
      runtimeBgScaleY = MAP_BG_SCALE_Y;
      territoryTransformByName.clear();
      selectedTerritoryNames.clear();
      updateCalibrationReadout();
      applyCalibrationOffset();
      applyBackgroundScale();
    });
  }

  if (calCopy) {
    calCopy.addEventListener('click', async function () {
      const text =
        'MAP_OFFSET_X_PX = ' +
        runtimeOffsetXPx +
        ';\nMAP_OFFSET_Y_PX = ' +
        runtimeOffsetYPx +
        ';\nMAP_SCALE_X = ' +
        runtimeScaleX.toFixed(3) +
        ';\nMAP_SCALE_Y = ' +
        runtimeScaleY.toFixed(3) +
        ';\nMAP_BG_SCALE_X = ' +
        runtimeBgScaleX.toFixed(3) +
        ';\nMAP_BG_SCALE_Y = ' +
        runtimeBgScaleY.toFixed(3) +
        ';\nSELECTED_TERRITORIES = ' +
        (selectedTerritoryNames.size ? Array.from(selectedTerritoryNames).join(', ') : 'None') +
        ';\nSELECTION_MOVE_X = ' +
        getSelectionTransformBaseline().offsetX +
        ';\nSELECTION_MOVE_Y = ' +
        getSelectionTransformBaseline().offsetY +
        ';\nSELECTION_SCALE_X = ' +
        getSelectionTransformBaseline().scaleX.toFixed(3) +
        ';\nSELECTION_SCALE_Y = ' +
        getSelectionTransformBaseline().scaleY.toFixed(3) +
        ';';
      try {
        await navigator.clipboard.writeText(text);
        setStatus('info', 'Calibration offsets copied to clipboard.');
      } catch (e) {
        setStatus('warn', 'Copy failed. Use the shown values manually.');
      }
    });
  }

  if (calAutoFitBounds) {
    calAutoFitBounds.addEventListener('change', function () {
      useAutoFitBounds = !!calAutoFitBounds.checked;
      if (!geo) return;
      const resolved = resolveWorldBounds();
      geo = {
        xMin: resolved.xMin,
        xMax: resolved.xMax,
        zMin: resolved.zMin,
        zMax: resolved.zMax,
        imgW: geo.imgW,
        imgH: geo.imgH
      };
      updateCalibrationReadout();
      rebuildTerritoryLayers();
      setStatus('info', useAutoFitBounds ? 'Using auto-fit world bounds.' : 'Using fixed MAP_* bounds.');
    });
  }

  if (calScaleX) {
    calScaleX.addEventListener('input', function () {
      runtimeScaleX = (parseInt(calScaleX.value, 10) || 1000) / 1000;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calScaleY) {
    calScaleY.addEventListener('input', function () {
      runtimeScaleY = (parseInt(calScaleY.value, 10) || 1000) / 1000;
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calBgScaleX) {
    calBgScaleX.addEventListener('input', function () {
      runtimeBgScaleX = (parseInt(calBgScaleX.value, 10) || 1000) / 1000;
      updateCalibrationReadout();
      applyBackgroundScale();
    });
  }

  if (calBgScaleY) {
    calBgScaleY.addEventListener('input', function () {
      runtimeBgScaleY = (parseInt(calBgScaleY.value, 10) || 1000) / 1000;
      updateCalibrationReadout();
      applyBackgroundScale();
    });
  }

  if (calMultiSelect) {
    calMultiSelect.addEventListener('change', function () {
      multiSelectEnabled = !!calMultiSelect.checked;
      updateCalibrationReadout();
    });
  }

  if (calSelectionClear) {
    calSelectionClear.addEventListener('click', function () {
      selectedTerritoryNames.clear();
      updateCalibrationReadout();
      applyLayerStyles();
    });
  }

  if (calTerrOffsetX) {
    calTerrOffsetX.addEventListener('input', function () {
      if (selectedTerritoryNames.size === 0) return;
      const offsetX = parseInt(calTerrOffsetX.value, 10) || 0;
      const baseline = getSelectionTransformBaseline().offsetX;
      const delta = offsetX - baseline;
      applyTransformToSelection(function (current) {
        return { ...current, offsetX: current.offsetX + delta };
      });
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calTerrOffsetY) {
    calTerrOffsetY.addEventListener('input', function () {
      if (selectedTerritoryNames.size === 0) return;
      const offsetY = parseInt(calTerrOffsetY.value, 10) || 0;
      const baseline = getSelectionTransformBaseline().offsetY;
      const delta = offsetY - baseline;
      applyTransformToSelection(function (current) {
        return { ...current, offsetY: current.offsetY + delta };
      });
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calTerrScaleX) {
    calTerrScaleX.addEventListener('input', function () {
      if (selectedTerritoryNames.size === 0) return;
      const scaleX = (parseInt(calTerrScaleX.value, 10) || 1000) / 1000;
      const baseline = getSelectionTransformBaseline();
      applyScaleSpacingToSelection(scaleX, baseline.scaleY);
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calTerrScaleY) {
    calTerrScaleY.addEventListener('input', function () {
      if (selectedTerritoryNames.size === 0) return;
      const scaleY = (parseInt(calTerrScaleY.value, 10) || 1000) / 1000;
      const baseline = getSelectionTransformBaseline();
      applyScaleSpacingToSelection(baseline.scaleX, scaleY);
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  if (calTerrScaleReset) {
    calTerrScaleReset.addEventListener('click', function () {
      if (selectedTerritoryNames.size === 0) return;
      selectedTerritoryNames.forEach(function (name) {
        territoryTransformByName.delete(name);
      });
      updateCalibrationReadout();
      applyCalibrationOffset();
    });
  }

  refreshDragToggleUi();

  const ok = await loadData(false);
  if (!ok) return;
  rebuildGuildOptions();
  try {
    await setupMap();
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Map init failed';
    setStatus('error', msg);
    return;
  }

  map.on('mousedown', function (ev) {
    if (!dragTerritoriesEnabled) return;
    isDraggingTerritories = true;
    dragStartClientX = ev.originalEvent.clientX;
    dragStartClientY = ev.originalEvent.clientY;
    dragStartOffsetX = runtimeOffsetXPx;
    dragStartOffsetY = runtimeOffsetYPx;
    map.dragging.disable();
    L.DomEvent.stop(ev.originalEvent);
  });

  map.on('mousemove', function (ev) {
    if (!isDraggingTerritories) return;
    const dx = ev.originalEvent.clientX - dragStartClientX;
    const dy = ev.originalEvent.clientY - dragStartClientY;
    runtimeOffsetXPx = dragStartOffsetX + Math.round(dx);
    runtimeOffsetYPx = dragStartOffsetY + Math.round(dy);
    updateCalibrationReadout();
    applyCalibrationOffset();
  });

  function stopTerritoryDragging() {
    if (!isDraggingTerritories) return;
    isDraggingTerritories = false;
    if (!dragTerritoriesEnabled) {
      map.dragging.enable();
    }
    setStatus(
      'info',
      'Drag complete. Current offsets: X ' +
        runtimeOffsetXPx +
        ', Y ' +
        runtimeOffsetYPx +
        '.'
    );
  }

  map.on('mouseup', stopTerritoryDragging);
  map.on('mouseout', stopTerritoryDragging);
  map.on('dragstart', function () {
    if (dragTerritoriesEnabled && isDraggingTerritories) {
      isDraggingTerritories = false;
    }
  });

  renderTable();
  updateSimulatePanel();
}
