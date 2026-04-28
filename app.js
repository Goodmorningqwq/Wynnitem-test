// Main Application Logic

import { cache, filterAndSortItems, filterByCategory, filterByArmourType, fetchItemPages, getAllFetchedItems, clearPageCache, fetchFilteredItems, triggerItemRefresh } from './api.js?v=20260428d';

// App State
const AppState = {
  SEARCH: 'search',
  LOADING: 'loading',
  RESULTS: 'results'
};

const ITEMS_PER_PAGE = 50;
const TOTAL_PAGES = 276;
const BATCH_SIZE = 5;
const PAGES_PER_MINUTE = 15;
const ADMIN_TOKEN_STORAGE_KEY = 'cacheAdminToken';

// State variables
let currentState = AppState.SEARCH;
let currentCategory = null;
let allLoadedItems = [];
let filteredItems = [];
let currentPage = 1;
let totalPages = 1;
let loadingCancelled = false;
let selectedWeaponType = '';
let selectedArmorType = '';
let selectedAccessoryType = '';
let selectedMiscType = '';

// DOM Elements (initialized in init)
let searchPanelEl, loadingOverlayEl, resultsPanelEl;
let loadingTitleEl, loadingSubtitleEl, progressBarEl, progressTextEl, etaTextEl;
let resultsTitleEl, itemCountResultsEl, itemsGridEl, emptyStateEl, paginationEl, pageInfoEl;
let categoryButtons, categorySwitchBtns, backBtnEl, applyFiltersBtnEl, clearFiltersBtnEl;
let tierFilterSearchEl, levelMinFilterSearchEl, levelMaxFilterSearchEl;
let weaponTypeFiltersEl, armorTypeFiltersEl, accessoryTypeFiltersEl, miscTypeFiltersEl;
let weaponTypeBtns, armorTypeBtns, accessoryTypeBtns, miscTypeBtns;
let tierFilterResultsEl, levelMinFilterResultsEl, levelMaxFilterResultsEl;
let headerItemCountEl, itemModal, modalTitle, modalContent, closeModalBtn;
let itemAdminRefreshRowEl, itemAdminRefreshBtnEl, itemAdminRefreshStatusEl, itemAdminClearTokenBtnEl;
let itemAdminRefreshInFlight = false;

// TIER_COLORS - Updated palette
const TIER_COLORS = {
  common: '#FFFFFF',
  uncommon: '#22C55E',
  rare: '#3B82F6',
  epic: '#A855F7',
  legendary: '#F97316',
  fabled: '#EF4444',
  mythic: '#EC4899',
  gray: '#6B7280',
};

// Tier glow RGB for box shadows
const TIER_GLOW_RGB = {
  common: '255, 255, 255',
  uncommon: '34, 197, 94',
  rare: '59, 130, 246',
  epic: '168, 85, 247',
  legendary: '249, 115, 22',
  fabled: '239, 68, 68',
  mythic: '236, 72, 153',
  gray: '107, 114, 128',
};

// Helper Functions
function getTierStyle(tier) {
  const t = tier?.toLowerCase() ?? 'gray';
  const hex = TIER_COLORS[t] ?? TIER_COLORS.gray;
  const glowRgb = TIER_GLOW_RGB[t] ?? TIER_GLOW_RGB.gray;
  return {
    textColor: hex,
    borderColor: hex,
    glowRgb: glowRgb,
    tierClass: `tier-${t}`,
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function getItemStats(item) {
  const isWeapon = item.type?.toLowerCase() === 'weapon';
  const base = item.base || {};
  
  const elementalDamages = [];
  const elementalMap = {
    baseEarthDamage: { name: 'Earth', color: '#00AA00' },
    baseFireDamage: { name: 'Fire', color: '#FF5555' },
    baseWaterDamage: { name: 'Water', color: '#5555FF' },
    baseThunderDamage: { name: 'Thunder', color: '#FFAA00' },
    baseAirDamage: { name: 'Air', color: '#FFFFFF' }
  };
  
  for (const [key, info] of Object.entries(elementalMap)) {
    if (base[key]) {
      elementalDamages.push({
        name: info.name,
        color: info.color,
        min: base[key].min,
        max: base[key].max
      });
    }
  }
  
  return {
    isWeapon,
    attackSpeed: item.attackSpeed?.replace(/_/g, ' ') || null,
    damage: base.baseDamage ? { min: base.baseDamage.min, max: base.baseDamage.max } : null,
    elementalDamages,
    averageDPS: item.averageDps || item.averageDPS || null,
    baseHealth: base.baseHealth || null,
    armorType: (item.armourType || item.subType)?.replace(/_/g, ' ') || null,
    classReq: item.requirements?.classRequirement?.toLowerCase() || 'Universal',
    level: item.requirements?.level || '?',
    powderSlots: item.powderSlots || 0,
  };
}

function getRequirements(item) {
  const reqs = item.requirements || {};
  const result = {};
  if (reqs.strength) result.strength = reqs.strength;
  if (reqs.dexterity) result.dexterity = reqs.dexterity;
  if (reqs.intelligence) result.intelligence = reqs.intelligence;
  if (reqs.defence) result.defence = reqs.defence;
  if (reqs.agility) result.agility = reqs.agility;
  return result;
}

function getSkillPointIds(item) {
  const ids = item.identifications || {};
  const skillPoints = {};
  const rawFields = ['rawStrength', 'rawDexterity', 'rawIntelligence', 'rawAgility', 'rawDefense'];
  rawFields.forEach(field => {
    if (ids[field]) {
      const key = field.replace('raw', '').toLowerCase();
      skillPoints[key] = ids[field];
    }
  });
  return skillPoints;
}

function getOtherIds(item) {
  const ids = item.identifications || {};
  const otherIds = {};
  Object.entries(ids).forEach(([key, value]) => {
    if (!key.startsWith('raw')) {
      otherIds[key] = value;
    }
  });
  return otherIds;
}

function formatIdValue(value) {
  if (typeof value === 'object') {
    const min = value.min ?? value.raw ?? 0;
    const max = value.max ?? min;
    return max !== min ? `${min} → ${max}` : `${min}`;
  }
  return `${value}`;
}

function formatIdName(name) {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim();
}

function formatStatReqLabel(key) {
  const labels = {
    strength: 'STR',
    dexterity: 'DEX',
    intelligence: 'INT',
    defence: 'DEF',
    agility: 'AGI',
  };
  return labels[key] || key.substring(0, 3).toUpperCase();
}

function getItemCategory(item) {
  const classReq = item.classRequirement?.toLowerCase();
  const weaponType = (item.weaponType || item.subType)?.toLowerCase();
  const armorType = (item.armourType || item.subType)?.toLowerCase();
  
  if (classReq === 'warrior') return '⚔️';
  if (classReq === 'archer') return '🏹';
  if (classReq === 'assassin') return '🗡️';
  if (classReq === 'mage') return '🔮';
  if (classReq === 'shaman') return '✨';
  
  if (armorType === 'helmet' || armorType === 'helm') return '🪖';
  if (armorType === 'chestplate' || armorType === 'chest') return '👕';
  if (armorType === 'leggings' || armorType === 'legging' || armorType === 'legs') return '👖';
  if (armorType === 'boots' || armorType === 'boot') return '👟';
  if (armorType === 'ring') return '💍';
  if (armorType === 'bracelet') return '📿';
  if (armorType === 'necklace') return '📿';
  
  if (item.type?.toLowerCase() === 'weapon') {
    if (weaponType === 'bow') return '🏹';
    if (weaponType === 'wand') return '🔮';
    if (weaponType === 'spear') return '🔱';
    if (weaponType === 'dagger') return '🗡️';
    if (weaponType === 'relik') return '✨';
    return '⚔️';
  }
  
  if (item.type?.toLowerCase() === 'armour') {
    return '🛡️';
  }
  
  return '';
}

function getCategoryLabel(item) {
  const classReq = item.classRequirement;
  const weaponType = item.weaponType || item.subType;
  const armorType = item.armourType || item.subType;
  
  if (classReq === 'warrior') return 'Warrior';
  if (classReq === 'archer') return 'Archer';
  if (classReq === 'assassin') return 'Assassin';
  if (classReq === 'mage') return 'Mage';
  if (classReq === 'shaman') return 'Shaman';
  
  if (armorType) {
    const at = armorType.toLowerCase();
    if (at === 'helmet' || at === 'helm') return 'Helmet';
    if (at === 'chestplate' || at === 'chest') return 'Chestplate';
    if (at === 'leggings' || at === 'legging' || at === 'legs') return 'Leggings';
    if (at === 'boots' || at === 'boot') return 'Boots';
    if (at === 'ring') return 'Ring';
    if (at === 'bracelet') return 'Bracelet';
    if (at === 'necklace') return 'Necklace';
  }
  
  if (item.type?.toLowerCase() === 'weapon') {
    if (weaponType === 'bow') return 'Archer';
    if (weaponType === 'wand') return 'Mage';
    if (weaponType === 'spear') return 'Warrior';
    if (weaponType === 'dagger') return 'Assassin';
    if (weaponType === 'relik') return 'Shaman';
  }
  
  return '';
}

function getSignedClass(value) {
  if (typeof value === 'number') {
    if (value > 0) return 'game-positive';
    if (value < 0) return 'game-negative';
    return 'game-value';
  }
  return 'game-value';
}

function getOrderedElementDamages(elementalDamages) {
  const order = ['earth', 'thunder', 'water', 'fire', 'air'];
  return [...elementalDamages].sort((a, b) => order.indexOf(a.name.toLowerCase()) - order.indexOf(b.name.toLowerCase()));
}

function getOrderedRequirements(reqs) {
  const order = ['strength', 'dexterity', 'intelligence', 'defence', 'agility'];
  return order.filter((key) => reqs[key] != null).map((key) => [key, reqs[key]]);
}

function getOrderedSkillPoints(skillPoints) {
  const order = ['strength', 'dexterity', 'intelligence', 'defense', 'agility'];
  return order.filter((key) => skillPoints[key] != null).map((key) => [key, skillPoints[key]]);
}

function formatRequirementLabel(key) {
  const labels = {
    strength: 'Strength Min',
    dexterity: 'Dexterity Min',
    intelligence: 'Intelligence Min',
    defence: 'Defence Min',
    agility: 'Agility Min',
  };
  return labels[key] || `${formatIdName(key)} Min`;
}

function formatIdDisplayRange(value) {
  if (typeof value === 'object' && value !== null) {
    const min = value.min ?? value.raw ?? 0;
    const max = value.max ?? min;
    return min === max ? `${min}` : `${min}-${max}`;
  }
  return `${value}`;
}

function getSignedIdClass(value) {
  if (typeof value === 'object' && value !== null) {
    const min = value.min ?? value.raw ?? 0;
    const max = value.max ?? min;
    if (min > 0 && max > 0) return 'game-positive';
    if (min < 0 && max < 0) return 'game-negative';
    return 'game-value';
  }
  return getSignedClass(value);
}

function createItemCard(item) {
  const tierStyle = getTierStyle(item.tier || item.rarity);
  const type = item.type || 'Unknown';
  const stats = getItemStats(item);
  const reqs = getRequirements(item);
  const skillPoints = getSkillPointIds(item);
  const otherIds = getOtherIds(item);
  const orderedReqs = getOrderedRequirements(reqs);
  const orderedSkillPoints = getOrderedSkillPoints(skillPoints);
  const orderedElemental = getOrderedElementDamages(stats.elementalDamages);
  const majorIds = item.majorIds ? Object.entries(item.majorIds) : [];
  const sortedOtherIds = Object.entries(otherIds).sort((a, b) => formatIdName(a[0]).localeCompare(formatIdName(b[0])));

  const wpType = item.weaponType || item.subType;
  const amType = item.armourType || item.subType;
  const weaponTypeLabel = wpType ? wpType.charAt(0).toUpperCase() + wpType.slice(1) : null;
  const armorTypeLabel = amType ? amType.charAt(0).toUpperCase() + amType.slice(1) : null;
  const typeLabel = weaponTypeLabel || armorTypeLabel || type;

  let detailsHtml = '<div class="card-details text-xs mt-3 pt-3 space-y-0.5" style="border-top: 1px solid rgba(80,80,80,0.3);">';

  if (stats.isWeapon) {
    if (stats.damage) {
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">Damage</span><span class="game-neutral font-semibold">${stats.damage.min}-${stats.damage.max}</span></div>`;
    }
    orderedElemental.forEach((el) => {
      detailsHtml += `<div class="stat-row"><span style="color:${el.color}">${el.name}</span><span style="color:${el.color}" class="font-semibold">${el.min}-${el.max}</span></div>`;
    });
    if (stats.attackSpeed) {
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">Speed</span><span class="text-gray-300">${escapeHtml(stats.attackSpeed)}</span></div>`;
    }
  } else {
    if (stats.baseHealth) {
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">Health</span><span class="game-positive font-semibold">+${escapeHtml(stats.baseHealth)}</span></div>`;
    }
    if (stats.armorType) {
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">Type</span><span class="text-gray-300 capitalize">${escapeHtml(stats.armorType)}</span></div>`;
    }
  }

  if (orderedReqs.length > 0 || stats.level) {
    if (stats.level) {
      detailsHtml += `<div class="stat-row mt-2"><span class="text-gray-500 text-[10px] uppercase tracking-wider">Requirements</span><span></span></div>`;
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">Level</span><span class="text-gray-300">${escapeHtml(stats.level)}</span></div>`;
    }
    orderedReqs.slice(0, 3).forEach(([key, value]) => {
      detailsHtml += `<div class="stat-row"><span class="text-gray-400">${formatStatReqLabel(key)}</span><span class="text-gray-300">${escapeHtml(value)}</span></div>`;
    });
  }

  if (majorIds.length > 0) {
    detailsHtml += `<div class="stat-row mt-2"><span class="game-cyan text-[10px] uppercase tracking-wider">Major</span><span></span></div>`;
    const [majorName] = majorIds[0];
    detailsHtml += `<div class="stat-row"><span class="game-cyan">+${escapeHtml(majorName)}</span><span></span></div>`;
  }

  detailsHtml += '</div>';

  return `
    <div 
      class="item-card p-4 cursor-pointer relative"
      style="--tier-color: ${tierStyle.borderColor}; --tier-glow-rgb: ${tierStyle.glowRgb};"
      data-item-name="${escapeAttr(item.name)}"
    >
      <div class="flex items-start justify-between mb-2">
        <div class="flex-1 min-w-0">
          <div class="font-bold text-base leading-tight text-white truncate pr-2" style="color: ${tierStyle.textColor};">${escapeHtml(item.displayName || item.name)}</div>
          <div class="flex items-center gap-2 mt-1.5">
            <span class="tag-pill ${tierStyle.tierClass}">${escapeHtml(item.tier || item.rarity || 'Unknown')}</span>
            <span class="tag-pill">Lv ${escapeHtml(stats.level)}</span>
          </div>
        </div>
        <div class="flex flex-col items-end gap-1">
          <span class="text-2xl opacity-80">${getItemCategory(item) || '📦'}</span>
        </div>
      </div>
      
      <div class="flex items-center gap-2 mb-3">
        <span class="text-gray-400 text-xs capitalize">${escapeHtml(typeLabel)}</span>
        <span class="text-gray-600">•</span>
        <span class="class-badge capitalize">${escapeHtml(stats.classReq)}</span>
      </div>
      
      ${detailsHtml}
    </div>
  `;
}

// UI State Functions
function showSearchPanel() {
  searchPanelEl.classList.remove('hidden');
  loadingOverlayEl.classList.add('hidden');
  resultsPanelEl.classList.add('hidden');
  if (headerItemCountEl && headerItemCountEl.parentElement) {
    headerItemCountEl.parentElement.classList.add('hidden');
  }
  currentState = AppState.SEARCH;
}

function updateSubTypeFilters(category) {
  weaponTypeFiltersEl.classList.add('hidden');
  armorTypeFiltersEl.classList.add('hidden');
  accessoryTypeFiltersEl.classList.add('hidden');
  miscTypeFiltersEl.classList.add('hidden');
  
  if (category === 'weapon') {
    weaponTypeFiltersEl.classList.remove('hidden');
    selectedWeaponType = '';
    weaponTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
    weaponTypeBtns.forEach(b => {
      if (b.dataset.weaponType === '') b.classList.add('theme-btn-selected');
    });
  } else if (category === 'armour') {
    armorTypeFiltersEl.classList.remove('hidden');
    selectedArmorType = '';
    armorTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
    armorTypeBtns.forEach(b => {
      if (b.dataset.armorType === '') b.classList.add('theme-btn-selected');
    });
  } else if (category === 'accessory') {
    accessoryTypeFiltersEl.classList.remove('hidden');
    selectedAccessoryType = '';
    accessoryTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
    accessoryTypeBtns.forEach(b => {
      if (b.dataset.accessoryType === '') b.classList.add('theme-btn-selected');
    });
  } else if (category === 'misc') {
    miscTypeFiltersEl.classList.remove('hidden');
    selectedMiscType = '';
    miscTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
    miscTypeBtns.forEach(b => {
      if (b.dataset.miscType === '') b.classList.add('theme-btn-selected');
    });
  }
}

function showLoadingOverlay(percent, loaded, total, eta) {
  searchPanelEl.classList.add('hidden');
  loadingOverlayEl.classList.remove('hidden');
  resultsPanelEl.classList.add('hidden');
  
  progressBarEl.style.width = `${percent}%`;
  progressTextEl.textContent = `${loaded} / ${total} pages`;
  etaTextEl.textContent = eta;
  
  updateSkeletonCards(loaded);
}

function updateSkeletonCards(pageLoaded) {
  const skeletonGrid = document.getElementById('skeletonGrid');
  if (!skeletonGrid) return;
  
  const cardCount = 8;
  let html = '';
  
  for (let i = 0; i < cardCount; i++) {
    const delay = (i % 4) * 100;
    const heightVariant = [180, 200, 170, 195, 185, 210, 175, 190][i];
    
    html += `
      <div class="skeleton-card" style="animation-delay: ${delay}ms;">
        <div class="skeleton h-4 w-3/4 mb-3" style="height: 16px;"></div>
        <div class="flex gap-2 mb-3">
          <div class="skeleton" style="width: 60px; height: 18px; border-radius: 9999px;"></div>
          <div class="skeleton" style="width: 40px; height: 18px; border-radius: 9999px;"></div>
        </div>
        <div class="skeleton mb-2" style="height: 12px; width: 100%;"></div>
        <div class="skeleton mb-2" style="height: 12px; width: 80%;"></div>
        <div class="skeleton mb-2" style="height: 12px; width: 90%;"></div>
        <div class="skeleton" style="height: 12px; width: 60%;"></div>
      </div>
    `;
  }
  
  skeletonGrid.innerHTML = html;
}

function showResults(items, category) {
  searchPanelEl.classList.add('hidden');
  loadingOverlayEl.classList.add('hidden');
  resultsPanelEl.classList.remove('hidden');
  
  const headerItemCountEl2 = document.getElementById('headerItemCount2');
  if (headerItemCountEl2) {
    headerItemCountEl2.textContent = items.length;
  }
  
  const resultsItemCountEl = document.getElementById('resultsItemCount');
  if (resultsItemCountEl) {
    resultsItemCountEl.classList.remove('hidden');
    const itemCountHeader = resultsItemCountEl.querySelector('#itemCountHeader');
    if (itemCountHeader) {
      itemCountHeader.textContent = items.length;
    }
  }
  
  if (headerItemCountEl) {
    headerItemCountEl.textContent = items.length;
  }
  
  const categoryNames = {
    armour: 'Armor',
    weapon: 'Weapons',
    accessory: 'Accessories',
    misc: 'Misc'
  };
  
  resultsTitleEl.textContent = categoryNames[category] || 'Results';
  itemCountResultsEl.textContent = `${items.length} items`;
  
  currentState = AppState.RESULTS;
  updateCategorySwitchButtons(category);
}

// Filter Functions
function getSearchFilters() {
  const tier = tierFilterSearchEl?.value || '';
  const levelMin = levelMinFilterSearchEl?.value ? Number(levelMinFilterSearchEl.value) : null;
  const levelMax = levelMaxFilterSearchEl?.value ? Number(levelMaxFilterSearchEl.value) : null;
  return { tier, levelMin, levelMax };
}

function getResultsFilters() {
  const tier = tierFilterResultsEl?.value || '';
  const levelMin = levelMinFilterResultsEl?.value ? Number(levelMinFilterResultsEl.value) : null;
  const levelMax = levelMaxFilterResultsEl?.value ? Number(levelMaxFilterResultsEl.value) : null;
  return { tier, levelMin, levelMax };
}

function applyFiltersToItems(items) {
  const { tier, levelMin, levelMax } = currentState === AppState.SEARCH ? getSearchFilters() : getResultsFilters();
  
  let filtered = items;
  
  if (tier) {
    filtered = filtered.filter(item => (item.tier || item.rarity)?.toLowerCase() === tier.toLowerCase());
  }
  
  if (levelMin != null) {
    filtered = filtered.filter(item => {
      const itemLevel = item.requirements?.level;
      return itemLevel != null && itemLevel >= levelMin;
    });
  }
  
  if (levelMax != null) {
    filtered = filtered.filter(item => {
      const itemLevel = item.requirements?.level;
      return itemLevel != null && itemLevel <= levelMax;
    });
  }
  
  return filtered;
}

function clearFilters() {
  tierFilterSearchEl.value = '';
  levelMinFilterSearchEl.value = '';
  levelMaxFilterSearchEl.value = '';
  tierFilterResultsEl.value = '';
  levelMinFilterResultsEl.value = '';
  levelMaxFilterResultsEl.value = '';
}

function getAdminToken() {
  try {
    return String(localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
}

function setAdminRefreshStatus(message, tone = 'neutral') {
  if (!itemAdminRefreshStatusEl) return;
  itemAdminRefreshStatusEl.textContent = message;
  itemAdminRefreshStatusEl.classList.remove('text-gray-400', 'text-emerald-300', 'text-red-300', 'text-violet-300', 'text-amber-300');
  if (tone === 'success') {
    itemAdminRefreshStatusEl.classList.add('text-emerald-300');
  } else if (tone === 'error') {
    itemAdminRefreshStatusEl.classList.add('text-red-300');
  } else if (tone === 'progress') {
    itemAdminRefreshStatusEl.classList.add('text-violet-300');
  } else if (tone === 'warn') {
    itemAdminRefreshStatusEl.classList.add('text-amber-300');
  } else {
    itemAdminRefreshStatusEl.classList.add('text-gray-400');
  }
}

function updateAdminRefreshVisibility() {
  const token = getAdminToken();
  if (!itemAdminRefreshRowEl) return;
  const hasToken = token.length > 0;
  itemAdminRefreshRowEl.classList.toggle('hidden', !hasToken);
  if (hasToken) {
    setAdminRefreshStatus('Ready to force refresh item snapshots.', 'neutral');
  }
}

async function handleItemAdminRefresh() {
  if (itemAdminRefreshInFlight) return;
  const token = getAdminToken();
  if (!token) {
    setAdminRefreshStatus('Admin token missing. Add cacheAdminToken in localStorage.', 'warn');
    updateAdminRefreshVisibility();
    return;
  }

  itemAdminRefreshInFlight = true;
  if (itemAdminRefreshBtnEl) itemAdminRefreshBtnEl.disabled = true;
  setAdminRefreshStatus('Refresh running...', 'progress');

  try {
    const payload = await triggerItemRefresh(token, 'quick');
    const itemCount = Number(payload?.items || 0).toLocaleString();
    const pages = Number(payload?.pages || 0);
    const duration = payload?.duration || '?';
    if (payload?.fromLastGood) {
      setAdminRefreshStatus(`Quick refresh complete from stable snapshot: ${itemCount} items across ${pages} pages.`, 'success');
    } else {
      setAdminRefreshStatus(`Refresh complete: ${itemCount} items across ${pages} pages (${duration}).`, 'success');
    }
  } catch (err) {
    const status = Number(err?.status || 0);
    const alreadyRunning = Boolean(err?.payload?.alreadyRunning);
    if (alreadyRunning || status === 409) {
      setAdminRefreshStatus('Refresh already running. Try again shortly.', 'warn');
    } else if (status === 403) {
      setAdminRefreshStatus('Invalid admin token. Clear token and set a valid one.', 'error');
    } else {
      setAdminRefreshStatus(`Refresh failed: ${err.message || 'unknown error'}`, 'error');
    }
  } finally {
    itemAdminRefreshInFlight = false;
    if (itemAdminRefreshBtnEl) itemAdminRefreshBtnEl.disabled = false;
  }
}

// Loading Functions
function calculateETA(loaded, total, cachedPages) {
  if (loaded === 0) return 'Calculating...';
  
  if (cachedPages >= total) return 'Loading from cache...';
  
  const uncachedRemaining = total - cachedPages - loaded;
  if (uncachedRemaining <= 0) return 'Processing results...';
  
  const minutesRemaining = Math.ceil(uncachedRemaining / PAGES_PER_MINUTE);
  if (minutesRemaining < 1) return 'Almost done...';
  if (minutesRemaining === 1) return '~1 minute remaining';
  return `~${minutesRemaining} minutes remaining`;
}

async function loadItemsForCategory(category) {
  loadingCancelled = false;
  currentCategory = category;
  
  clearPageCache();
  
  const categoryNames = {
    armour: 'Armor',
    weapon: 'Weapons',
    accessory: 'Accessories',
    misc: 'Misc'
  };
  
  loadingTitleEl.textContent = `Loading ${categoryNames[category]}...`;
  loadingSubtitleEl.textContent = 'Please wait while we fetch item data';
  
  const filters = getSearchFilters();
  
  try {
    const result = await fetchFilteredItems({
      category,
      weaponType: selectedWeaponType || undefined,
      armourType: selectedArmorType || undefined,
      accessoryType: selectedAccessoryType || undefined,
      miscType: selectedMiscType || undefined,
      tier: filters.tier || undefined,
      levelMin: filters.levelMin,
      levelMax: filters.levelMax
    }, (currentPageNum, totalPagesNum, itemCount, cachedPages = 0) => {
      if (loadingCancelled) return;
      const percent = Math.round((currentPageNum / totalPagesNum) * 100);
      const eta = calculateETA(currentPageNum, totalPagesNum, cachedPages);
      showLoadingOverlay(percent, currentPageNum, totalPagesNum, eta);
    });
    
    if (loadingCancelled) {
      showSearchPanel();
      return;
    }

    if (result.staleSnapshot) {
      loadingSubtitleEl.textContent = 'Using last stable cache snapshot while refresh runs';
    }
    
    allLoadedItems = Object.entries(result.items).map(([name, item]) => ({ name: item.displayName || item.internalName || item.name || name, ...item }));
    allLoadedItems.sort((a, b) => {
      const tierOrder = ['mythic', 'fabled', 'legendary', 'epic', 'rare', 'uncommon', 'common'];
      const aIdx = tierOrder.indexOf((a.tier || a.rarity)?.toLowerCase() || '');
      const bIdx = tierOrder.indexOf((b.tier || b.rarity)?.toLowerCase() || '');
      return (aIdx === -1 ? tierOrder.length : aIdx) - (bIdx === -1 ? tierOrder.length : bIdx);
    });
    
    filteredItems = [...allLoadedItems];
    
    showLoadingOverlay(100, 1, 1, 'Complete!');
    
    setTimeout(() => {
      showResults(filteredItems, category);
      currentPage = 1;
      renderItems();
    }, 500);
    
  } catch (error) {
    console.error('Error loading items:', error);
    if (error.message.includes('429') || error.message.includes('rate')) {
      showSearchPanel();
      alert('Rate limited by the API. Please wait a minute and try again.');
    } else {
      showSearchPanel();
      alert(`Failed to load items: ${error.message}`);
    }
  }
}

function cancelLoading() {
  loadingCancelled = true;
}

// Rendering Functions
function renderItems() {
  if (filteredItems.length === 0) {
    itemsGridEl.classList.add('hidden');
    emptyStateEl.classList.remove('hidden');
    paginationEl.classList.add('hidden');
    return;
  }
  
  itemsGridEl.classList.remove('hidden');
  emptyStateEl.classList.add('hidden');
  paginationEl.classList.remove('hidden');
  
  itemsGridEl.innerHTML = '';
  
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = Math.min(startIndex + ITEMS_PER_PAGE, filteredItems.length);
  const itemsOnPage = filteredItems.slice(startIndex, endIndex);
  
  for (const item of itemsOnPage) {
    const card = createItemCard(item);
    itemsGridEl.innerHTML += card;
  }
  
  totalPages = Math.ceil(filteredItems.length / ITEMS_PER_PAGE);
  if (totalPages < 1) totalPages = 1;
  
  itemCountResultsEl.textContent = `${filteredItems.length} items`;
  headerItemCountEl.textContent = filteredItems.length;
  updatePagination();
  
  document.querySelectorAll('.item-card').forEach(card => {
    if (!card.dataset.listenersAttached) {
      card.dataset.listenersAttached = 'true';
      card.addEventListener('click', () => {
        const itemName = card.getAttribute('data-item-name');
        const item = filteredItems.find(i => i.name === itemName);
        showItemModal(itemName, item);
      });
    }
  });
}

function updatePagination() {
  const pageNumbersEl = document.getElementById('pageNumbers');
  const prevBtn = document.getElementById('prevPage');
  const nextBtn = document.getElementById('nextPage');
  
  if (pageInfoEl) {
    pageInfoEl.textContent = `Page ${currentPage} of ${totalPages}`;
  }
  
  if (prevBtn) {
    prevBtn.disabled = currentPage <= 1;
    prevBtn.classList.toggle('opacity-50', currentPage <= 1);
    prevBtn.classList.toggle('cursor-not-allowed', currentPage <= 1);
  }
  
  if (nextBtn) {
    nextBtn.disabled = currentPage >= totalPages;
    nextBtn.classList.toggle('opacity-50', currentPage >= totalPages);
    nextBtn.classList.toggle('cursor-not-allowed', currentPage >= totalPages);
  }
  
  if (pageNumbersEl) {
    let pagesHtml = '';
    const maxVisible = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
    let endPage = Math.min(totalPages, startPage + maxVisible - 1);
    
    if (endPage - startPage < maxVisible - 1) {
      startPage = Math.max(1, endPage - maxVisible + 1);
    }
    
    for (let i = startPage; i <= endPage; i++) {
      const active = i === currentPage ? 'theme-btn-selected' : 'theme-btn';
      pagesHtml += `<button class="page-btn px-3 py-1 rounded ${active}" data-page="${i}">${i}</button>`;
    }
    pageNumbersEl.innerHTML = pagesHtml;
    
    document.querySelectorAll('.page-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        goToPage(parseInt(btn.dataset.page));
      });
    });
  }
}

function goToPage(page) {
  if (page < 1 || page > totalPages) return;
  currentPage = page;
  renderItems();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateCategorySwitchButtons(activeCategory) {
  categorySwitchBtns.forEach(btn => {
    if (btn.dataset.category === activeCategory) {
      btn.classList.add('theme-btn-selected');
    } else {
      btn.classList.remove('theme-btn-selected');
    }
  });
}

// Modal Functions
async function showItemModal(name, item) {
  if (!name && !item) return;
  
  const itemName = name || item?.name || 'Unknown Item';
  
  let itemData = item;
  if (!itemData) {
    itemData = filteredItems.find(i => i.name === itemName);
  }
  
  if (!itemData) {
    modalTitle.textContent = itemName;
    modalTitle.style.color = TIER_COLORS.gray;
    modalContent.innerHTML = `<div class="text-center py-8"><p class="text-gray-400">Loading item details...</p></div>`;
    itemModal.classList.remove('hidden');
    
    try {
      const searchResult = await quickSearch(itemName);
      itemData = searchResult[itemName];
      if (!itemData) {
        modalContent.innerHTML = `<div class="text-center py-8"><p class="text-red-400">Item not found</p></div>`;
        return;
      }
    } catch (e) {
      console.error('Failed to fetch item:', e);
      modalContent.innerHTML = `<div class="text-center py-8"><p class="text-red-400">Failed to load item: ${escapeHtml(e.message)}</p></div>`;
      return;
    }
  }
  
  const rarity = itemData?.tier || itemData?.rarity || 'common';
  const tierStyle = getTierStyle(rarity);
  const categoryIcon = getItemCategory(itemData);
  const stats = getItemStats(itemData);
  const reqs = getRequirements(itemData);
  const skillPoints = getSkillPointIds(itemData);
  const otherIds = getOtherIds(itemData);
  const orderedReqs = getOrderedRequirements(reqs);
  const orderedSkillPoints = getOrderedSkillPoints(skillPoints);
  const orderedElemental = getOrderedElementDamages(stats.elementalDamages);
  const sortedOtherIds = Object.entries(otherIds).sort((a, b) => formatIdName(a[0]).localeCompare(formatIdName(b[0])));
  
  modalTitle.textContent = itemName;
  modalTitle.style.color = tierStyle.textColor;

  const wpType = itemData?.weaponType || itemData?.subType;
  const amType = itemData?.armourType || itemData?.subType;
  const weaponTypeLabel = wpType ? wpType.charAt(0).toUpperCase() + wpType.slice(1) : null;
  const armorTypeLabel = amType ? amType.charAt(0).toUpperCase() + amType.slice(1) : null;
  const typeLabel = weaponTypeLabel || armorTypeLabel || itemData?.type || 'Unknown';

  let html = `<div class="space-y-4 max-h-[80vh] overflow-y-auto pr-2 text-sm">`;

  html += `
    <div class="flex items-start gap-4 pb-4" style="border-bottom: 1px solid rgba(80,80,80,0.3);">
      <div class="w-16 h-16 bg-gray-800/80 rounded-xl flex items-center justify-center text-3xl border border-gray-700/50" style="box-shadow: 0 0 20px rgba(${tierStyle.glowRgb}, 0.2);">
        ${categoryIcon || '🎒'}
      </div>
      <div class="flex-1 min-w-0">
        <div class="text-2xl font-bold leading-tight truncate mb-2" style="color:${tierStyle.textColor};">${escapeHtml(itemData?.displayName || itemData?.name || itemName)}</div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="modal-tier-badge" style="background: rgba(${tierStyle.glowRgb}, 0.15); border: 1px solid rgba(${tierStyle.glowRgb}, 0.4); color: ${tierStyle.textColor};">${escapeHtml(rarity.toUpperCase())}</span>
          <span class="text-gray-400 text-sm capitalize">${escapeHtml(typeLabel)}</span>
          <span class="class-badge capitalize">Lv ${escapeHtml(stats?.level ?? '?')}</span>
        </div>
      </div>
    </div>`;

  html += `<div class="space-y-3">`;
  
  if (stats.isWeapon) {
    let weaponStatsHtml = '';
    if (stats.damage) {
      weaponStatsHtml += `<div class="stat-row"><span class="text-gray-400">Neutral Damage</span><span class="game-neutral font-bold text-lg">${stats.damage.min}-${stats.damage.max}</span></div>`;
    }
    orderedElemental.forEach(el => {
      weaponStatsHtml += `<div class="stat-row"><span style="color:${el.color}">${el.name} Damage</span><span style="color:${el.color}" class="font-bold">${el.min}-${el.max}</span></div>`;
    });
    if (stats.attackSpeed) {
      weaponStatsHtml += `<div class="stat-row"><span class="text-gray-400">Attack Speed</span><span class="text-gray-300">${escapeHtml(stats.attackSpeed)}</span></div>`;
    }
    
    html += `
      <div class="game-modal-section p-4">
        <h3 class="game-section-title mb-3">Attack Stats</h3>
        <div class="space-y-1">
          ${weaponStatsHtml}
        </div>
      </div>`;
  } else {
    html += `
      <div class="game-modal-section p-4">
        <h3 class="game-section-title mb-3">Base Stats</h3>
        <div class="space-y-1">
          ${stats.baseHealth ? `<div class="stat-row"><span class="text-gray-400">Health</span><span class="game-positive font-bold">+${escapeHtml(stats.baseHealth)}</span></div>` : ''}
          ${stats.armorType ? `<div class="stat-row"><span class="text-gray-400">Armor Type</span><span class="text-gray-300 capitalize">${escapeHtml(stats.armorType)}</span></div>` : ''}
        </div>
      </div>`;
  }
  
  if (orderedReqs.length > 0 || stats.level) {
    html += `
      <div class="game-modal-section p-4">
        <h3 class="game-section-title mb-3">Requirements</h3>
        <div class="space-y-1">`;
    
    if (stats.level) {
      html += `<div class="stat-row"><span class="text-gray-400">Combat Level</span><span class="text-gray-300 font-semibold">${escapeHtml(stats.level)}</span></div>`;
    }
    html += `<div class="stat-row"><span class="text-gray-400">Class</span><span class="class-badge capitalize">${escapeHtml(stats.classReq)}</span></div>`;
    orderedReqs.forEach(([key, value]) => {
      html += `<div class="stat-row"><span class="text-gray-400">${formatRequirementLabel(key)}</span><span class="text-gray-300">${escapeHtml(value)}</span></div>`;
    });
    
    html += `</div></div>`;
  }
  
  if (orderedSkillPoints.length > 0) {
    html += `
      <div class="game-modal-section p-4">
        <h3 class="game-section-title mb-3">Skill Points</h3>
        <div class="grid grid-cols-2 gap-2">`;

    orderedSkillPoints.forEach(([key, value]) => {
      const plus = value > 0 ? '+' : '';
      html += `
        <div class="bg-gray-800/50 p-3 rounded-lg border border-gray-700/30">
          <div class="text-gray-400 text-xs mb-1">${escapeHtml(formatIdName(key))}</div>
          <div class="${getSignedClass(value)} text-lg font-bold">${plus}${escapeHtml(value)}</div>
        </div>`;
    });

    html += `</div></div>`;
  }

  if (sortedOtherIds.length > 0) {
    html += `
      <div class="game-modal-section p-4">
        <h3 class="game-section-title mb-3">Identifications</h3>
        <div class="grid gap-2">`;

    sortedOtherIds.forEach(([key, value]) => {
      html += `
        <div class="bg-gray-800/50 p-3 rounded-lg border border-gray-700/30 flex justify-between items-center">
          <span class="text-gray-300 capitalize">${escapeHtml(formatIdName(key))}</span>
          <span class="${getSignedIdClass(value)} font-semibold">${escapeHtml(formatIdDisplayRange(value))}</span>
        </div>`;
    });
    
    html += `</div></div>`;
  }
  
  if (itemData.majorIds && Object.keys(itemData.majorIds).length > 0) {
    html += `
      <div class="game-modal-section p-4" style="border-left: 3px solid var(--game-cyan);">
        <h3 class="game-section-title game-cyan mb-3">Major Identifications</h3>
        <div class="space-y-2">`;
    
    Object.entries(itemData.majorIds).forEach(([key, value]) => {
      html += `
        <div class="bg-gray-800/50 p-3 rounded-lg border border-gray-700/30">
          <div class="game-cyan font-bold mb-1">+${escapeHtml(key)}</div>
          <p class="text-gray-400 text-sm">${escapeHtml(value)}</p>
        </div>`;
    });
    
    html += `</div></div>`;
  }

  html += `
    <div class="game-modal-section p-4">
      <h3 class="game-section-title mb-3">Details</h3>
      <div class="space-y-2">
        <div class="stat-row"><span class="text-gray-400">Powder Slots</span><span class="text-gray-300">[${stats.powderSlots}/3]</span></div>
      </div>
    </div>`;

  if (itemData.lore) {
    html += `
      <div class="p-4 border-l-2 border-gray-600" style="background: rgba(30,30,30,0.5);">
        <div class="text-gray-500 text-xs uppercase tracking-wider mb-2">Lore</div>
        <p class="text-gray-400 italic leading-relaxed text-sm">${escapeHtml(itemData.lore.replace(/§./g, ''))}</p>
      </div>`;
  }
  
  html += `</div>`;
  html += `</div>`;
  
  modalContent.innerHTML = html;
  itemModal.classList.remove('hidden');
}

function closeModal() {
  itemModal.classList.add('hidden');
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  const headerLoginBtn = document.getElementById('headerLoginBtn');
  const headerUserBtn = document.getElementById('headerUserBtn');
  const userMenu = document.getElementById('userMenu');
  const userDisplayName = document.getElementById('userDisplayName');
  let currentUser = null;
  try {
    currentUser = localStorage.getItem('currentUser');
  } catch {
    currentUser = null;
  }
  if (currentUser) {
    headerLoginBtn?.classList.add('hidden');
    if (headerUserBtn) {
      headerUserBtn.classList.remove('hidden');
      headerUserBtn.textContent = currentUser;
    }
    userMenu?.classList.remove('hidden');
    if (userDisplayName) {
      userDisplayName.textContent = currentUser;
    }
  }
  document.getElementById('logoutBtn')?.addEventListener('click', () => {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('userHash');
    window.location.href = '/guild';
  });
  headerUserBtn?.addEventListener('click', () => {
    window.location.href = '/guild';
  });
  headerLoginBtn?.addEventListener('click', () => {
    window.location.href = '/login';
  });

  // Initialize DOM elements
  searchPanelEl = document.getElementById('searchPanel');
  loadingOverlayEl = document.getElementById('loadingOverlay');
  resultsPanelEl = document.getElementById('resultsPanel');
  
  loadingTitleEl = document.getElementById('loadingTitle');
  loadingSubtitleEl = document.getElementById('loadingSubtitle');
  progressBarEl = document.getElementById('progressBar');
  progressTextEl = document.getElementById('progressText');
  etaTextEl = document.getElementById('etaText');
  
  resultsTitleEl = document.getElementById('resultsTitle');
  itemCountResultsEl = document.getElementById('itemCountResults');
  itemsGridEl = document.getElementById('itemsGrid');
  emptyStateEl = document.getElementById('emptyState');
  paginationEl = document.getElementById('pagination');
  pageInfoEl = document.getElementById('pageInfo');
  
  categoryButtons = document.querySelectorAll('.category-btn');
  categorySwitchBtns = document.querySelectorAll('.category-switch-btn');
  backBtnEl = document.getElementById('backBtn');
  applyFiltersBtnEl = document.getElementById('applyFiltersBtn');
  clearFiltersBtnEl = document.getElementById('clearFiltersBtn');
  
  tierFilterSearchEl = document.getElementById('tierFilterSearch');
  levelMinFilterSearchEl = document.getElementById('levelMinFilterSearch');
  levelMaxFilterSearchEl = document.getElementById('levelMaxFilterSearch');
  weaponTypeFiltersEl = document.getElementById('weaponTypeFilters');
  armorTypeFiltersEl = document.getElementById('armorTypeFilters');
  accessoryTypeFiltersEl = document.getElementById('accessoryTypeFilters');
  miscTypeFiltersEl = document.getElementById('miscTypeFilters');
  weaponTypeBtns = document.querySelectorAll('.weapon-type-btn');
  armorTypeBtns = document.querySelectorAll('.armor-type-btn');
  accessoryTypeBtns = document.querySelectorAll('.accessory-type-btn');
  miscTypeBtns = document.querySelectorAll('.misc-type-btn');
  
  tierFilterResultsEl = document.getElementById('tierFilterResults');
  levelMinFilterResultsEl = document.getElementById('levelMinFilterResults');
  levelMaxFilterResultsEl = document.getElementById('levelMaxFilterResults');
  
  headerItemCountEl = document.getElementById('itemCountHeader');
  itemModal = document.getElementById('itemModal');
  modalTitle = document.getElementById('modalTitle');
  modalContent = document.getElementById('modalContent');
  closeModalBtn = document.getElementById('closeModal');
  itemAdminRefreshRowEl = document.getElementById('itemAdminRefreshRow');
  itemAdminRefreshBtnEl = document.getElementById('itemAdminRefreshBtn');
  itemAdminRefreshStatusEl = document.getElementById('itemAdminRefreshStatus');
  itemAdminClearTokenBtnEl = document.getElementById('itemAdminClearTokenBtn');
  
  // Event Listeners
  categoryButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      updateSubTypeFilters(category);
      currentCategory = category;
      
      if (category === 'weapon' || category === 'armour' || category === 'accessory' || category === 'misc') {
        searchPanelEl.classList.remove('hidden');
        loadingOverlayEl.classList.add('hidden');
        resultsPanelEl.classList.add('hidden');
        return;
      }
      
      loadingOverlayEl.classList.remove('hidden');
      searchPanelEl.classList.add('hidden');
      loadItemsForCategory(category);
    });
  });

  document.getElementById('searchBtn')?.addEventListener('click', () => {
    if (!currentCategory) {
      alert('Please select a category first');
      return;
    }
    
    if (currentCategory === 'weapon' && !selectedWeaponType) {
      alert('Please select a weapon type');
      return;
    }
    
    if (currentCategory === 'armour' && !selectedArmorType) {
      alert('Please select an armor piece');
      return;
    }
    
    if (currentCategory === 'accessory' && !selectedAccessoryType) {
      alert('Please select an accessory type');
      return;
    }
    
    if (currentCategory === 'misc' && !selectedMiscType) {
      alert('Please select a misc type');
      return;
    }
    
    loadingOverlayEl.classList.remove('hidden');
    searchPanelEl.classList.add('hidden');
    loadItemsForCategory(currentCategory);
  });

  weaponTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      weaponTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
      btn.classList.add('theme-btn-selected');
      selectedWeaponType = btn.dataset.weaponType;
    });
  });

  armorTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      armorTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
      btn.classList.add('theme-btn-selected');
      selectedArmorType = btn.dataset.armorType;
    });
  });

  accessoryTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      accessoryTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
      btn.classList.add('theme-btn-selected');
      selectedAccessoryType = btn.dataset.accessoryType;
    });
  });

  miscTypeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      miscTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
      btn.classList.add('theme-btn-selected');
      selectedMiscType = btn.dataset.miscType;
    });
  });

  categorySwitchBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const category = btn.dataset.category;
      
      if (category === 'weapon') {
        selectedWeaponType = '';
        weaponTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
        weaponTypeBtns.forEach(b => {
          if (b.dataset.weaponType === '') b.classList.add('theme-btn-selected');
        });
        searchPanelEl.classList.remove('hidden');
        loadingOverlayEl.classList.add('hidden');
        resultsPanelEl.classList.add('hidden');
        currentCategory = category;
        updateSubTypeFilters(category);
        return;
      }
      
      if (category === 'armour') {
        selectedArmorType = '';
        armorTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
        armorTypeBtns.forEach(b => {
          if (b.dataset.armorType === '') b.classList.add('theme-btn-selected');
        });
        searchPanelEl.classList.remove('hidden');
        loadingOverlayEl.classList.add('hidden');
        resultsPanelEl.classList.add('hidden');
        currentCategory = category;
        updateSubTypeFilters(category);
        return;
      }
      
      if (category === 'accessory') {
        selectedAccessoryType = '';
        accessoryTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
        accessoryTypeBtns.forEach(b => {
          if (b.dataset.accessoryType === '') b.classList.add('theme-btn-selected');
        });
        searchPanelEl.classList.remove('hidden');
        loadingOverlayEl.classList.add('hidden');
        resultsPanelEl.classList.add('hidden');
        currentCategory = category;
        updateSubTypeFilters(category);
        return;
      }
      
      if (category === 'misc') {
        selectedMiscType = '';
        miscTypeBtns.forEach(b => b.classList.remove('theme-btn-selected'));
        miscTypeBtns.forEach(b => {
          if (b.dataset.miscType === '') b.classList.add('theme-btn-selected');
        });
        searchPanelEl.classList.remove('hidden');
        loadingOverlayEl.classList.add('hidden');
        resultsPanelEl.classList.add('hidden');
        currentCategory = category;
        updateSubTypeFilters(category);
        return;
      }
      
      loadingOverlayEl.classList.remove('hidden');
      searchPanelEl.classList.add('hidden');
      loadItemsForCategory(category);
    });
  });

  backBtnEl.addEventListener('click', () => {
    cancelLoading();
    showSearchPanel();
  });

  applyFiltersBtnEl.addEventListener('click', () => {
    if (allLoadedItems.length === 0) return;
    filteredItems = applyFiltersToItems(allLoadedItems);
    currentPage = 1;
    renderItems();
  });

  clearFiltersBtnEl.addEventListener('click', () => {
    clearFilters();
    if (allLoadedItems.length > 0) {
      filteredItems = [...allLoadedItems];
      currentPage = 1;
      renderItems();
    }
  });

  document.getElementById('prevPage')?.addEventListener('click', () => goToPage(currentPage - 1));
  document.getElementById('nextPage')?.addEventListener('click', () => goToPage(currentPage + 1));

  closeModalBtn.addEventListener('click', closeModal);
  itemModal.addEventListener('click', (e) => {
    if (e.target === itemModal) closeModal();
  });

  itemAdminRefreshBtnEl?.addEventListener('click', handleItemAdminRefresh);
  itemAdminClearTokenBtnEl?.addEventListener('click', () => {
    try {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
    updateAdminRefreshVisibility();
  });

  updateAdminRefreshVisibility();

  showSearchPanel();
});
