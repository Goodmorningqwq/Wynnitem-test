/** @typedef {Record<string, string>} ResourceSet */
/** @typedef {{ name: string, resources: ResourceSet, tradeRoutes: string[], guild: { uuid: string, name: string, prefix: string }, acquired: string, minX: number, maxX: number, minZ: number, maxZ: number, emeralds: number, wood: number, ore: number, crops: number, fish: number, dominant: string, productionScore: number, ownerLabel: string }} MergedTerritory */

const STATIC_TERRITORIES_URL =
  'https://raw.githubusercontent.com/jakematt123/Wynncraft-Territory-Info/main/territories.json';
const LIVE_TERRITORIES_URL = 'https://api.wynncraft.com/v3/guild/list/territory';
const MAP_IMAGE_URL = '/main-map.webp';

/** @type {number | null} Manual override; null = derive from territory geometry */
const MAP_X_MIN = null;
const MAP_X_MAX = null;
const MAP_Z_MIN = null;
const MAP_Z_MAX = null;

/** Set true if the map appears vertically mirrored vs territories */
const FLIP_Z = false;

const WORLD_PADDING_RATIO = 0.05;

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

/**
 * Compute world axis bounds from merged list plus padding.
 * @param {MergedTerritory[]} list
 * @returns {{ xMin: number, xMax: number, zMin: number, zMax: number }}
 */
function worldBoundsFromList(list) {
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
  const padX = (xMax - xMin) * WORLD_PADDING_RATIO || 50;
  const padZ = (zMax - zMin) * WORLD_PADDING_RATIO || 50;
  return {
    xMin: xMin - padX,
    xMax: xMax + padX,
    zMin: zMin - padZ,
    zMax: zMax + padZ
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
  const nx = (x - xMin) / (xMax - xMin);
  let nz = (z - zMin) / (zMax - zMin);
  if (FLIP_Z) nz = 1 - nz;
  return L.latLng(nz * imgH, nx * imgW);
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
    let fillOpacity = 0.22;
    let color = baseColor;
    let weight = 1;
    if (simulateSelected.has(t.name)) {
      weight = 3;
      color = '#facc15';
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
          color: 'rgba(167,139,250,0.35)',
          weight: 1,
          dashArray: '6 6'
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
    const b = boundsFromWorldRect(
      t.minX,
      t.maxX,
      t.minZ,
      t.maxZ,
      geo.xMin,
      geo.xMax,
      geo.zMin,
      geo.zMax,
      geo.imgW,
      geo.imgH
    );
    map.fitBounds(b, { padding: [24, 24], maxZoom: 5, animate: true });
  }

  function attachLayerClick(layer, t) {
    layer.on('click', function (ev) {
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
      const rectBounds = boundsFromWorldRect(
        t.minX,
        t.maxX,
        t.minZ,
        t.maxZ,
        geo.xMin,
        geo.xMax,
        geo.zMin,
        geo.zMax,
        geo.imgW,
        geo.imgH
      );
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
    let xMin = MAP_X_MIN;
    let xMax = MAP_X_MAX;
    let zMin = MAP_Z_MIN;
    let zMax = MAP_Z_MAX;
    if (xMin == null || xMax == null || zMin == null || zMax == null) {
      const wb = worldBoundsFromList(mergedList);
      xMin = xMin != null ? xMin : wb.xMin;
      xMax = xMax != null ? xMax : wb.xMax;
      zMin = zMin != null ? zMin : wb.zMin;
      zMax = zMax != null ? zMax : wb.zMax;
    }
    geo = { xMin, xMax, zMin, zMax, imgW, imgH };
    const bounds = L.latLngBounds([[0, 0], [imgH, imgW]]);
    map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      zoomSnap: 0.25,
      attributionControl: false
    });
    imageOverlay = L.imageOverlay(MAP_IMAGE_URL, bounds).addTo(map);
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
  renderTable();
  updateSimulatePanel();
}
