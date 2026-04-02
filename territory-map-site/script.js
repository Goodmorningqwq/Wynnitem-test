(function () {
  const STATIC_TERRITORIES_URL =
    'https://raw.githubusercontent.com/jakematt123/Wynncraft-Territory-Info/main/territories.json';
  const MAP_IMAGE_URL = './main-map.webp';
  const MAP_X_MIN = -2500;
  const MAP_X_MAX = 2500;
  const MAP_Z_MIN = -6635;
  const MAP_Z_MAX = 0;
  const MAP_OFFSET_X_PX = 75;
  const MAP_OFFSET_Y_PX = -15;
  const MAP_SCALE_X = 1;
  const MAP_SCALE_Y = 1;
  const MAP_BG_SCALE_X = 0.803;
  const MAP_BG_SCALE_Y = 0.966;
  const LIVE_TERRITORIES_URL = '/api/territories';
  const SOCKET_DEV_PORT = 3001;
  const FLIP_Z = true;
  const UPGRADE_COSTS = {
    damage: [0, 50, 120, 250, 450, 700, 1000, 1400, 1900, 2500, 3200, 4000],
    attackSpeed: [0, 40, 100, 220, 400, 650, 950, 1350, 1800, 2400, 3100, 3900],
    health: [0, 60, 140, 280, 500, 780, 1100, 1550, 2100, 2800, 3600, 4500],
    defense: [0, 30, 80, 170, 320, 520, 780, 1100, 1500, 2000, 2600, 3300]
  };
  const UPGRADE_RESOURCE_BY_CATEGORY = {
    damage: 'ore',
    attackSpeed: 'crops',
    health: 'wood',
    defense: 'fish'
  };

  const state = {
    map: null,
    geo: null,
    territoryByName: new Map(),
    layerByName: new Map(),
    selectedTerritories: new Set(),
    socket: null,
    currentRoom: null,
    role: null,
    connected: false,
    armedForDefenderCreate: false,
    lastTickPayload: null,
    tickCountdownTimer: null,
    selectedUpgradeTerritory: '',
    upgradeNotices: [],
    sfxEnabled: true
  };

  const els = {
    createGameBtn: document.getElementById('createGameBtn'),
    joinCodeInput: document.getElementById('joinCodeInput'),
    joinGameBtn: document.getElementById('joinGameBtn'),
    statusText: document.getElementById('statusText'),
    lobbyOverlay: document.getElementById('lobbyOverlay'),
    roomCodeText: document.getElementById('roomCodeText'),
    copyCodeBtn: document.getElementById('copyCodeBtn'),
    roleText: document.getElementById('roleText'),
    gameStatusText: document.getElementById('gameStatusText'),
    countdownText: document.getElementById('countdownText'),
    readyStateText: document.getElementById('readyStateText'),
    selectionCountText: document.getElementById('selectionCountText'),
    territoryList: document.getElementById('territoryList'),
    readyBtn: document.getElementById('readyBtn'),
    resourcesPanel: document.getElementById('resourcesPanel'),
    resEmeralds: document.getElementById('resEmeralds'),
    resWood: document.getElementById('resWood'),
    resOre: document.getElementById('resOre'),
    resCrops: document.getElementById('resCrops'),
    resFish: document.getElementById('resFish'),
    tickCountdownText: document.getElementById('tickCountdownText'),
    tickMessages: document.getElementById('tickMessages'),
    upgradeMenuBtn: document.getElementById('upgradeMenuBtn'),
    upgradeModal: document.getElementById('upgradeModal'),
    upgradeModalCloseBtn: document.getElementById('upgradeModalCloseBtn'),
    upgradeTerritorySelect: document.getElementById('upgradeTerritorySelect'),
    upgradeRoleHint: document.getElementById('upgradeRoleHint'),
    upgradeDamageMeta: document.getElementById('upgradeDamageMeta'),
    upgradeAttackSpeedMeta: document.getElementById('upgradeAttackSpeedMeta'),
    upgradeHealthMeta: document.getElementById('upgradeHealthMeta'),
    upgradeDefenseMeta: document.getElementById('upgradeDefenseMeta'),
    upgradeDamageBtn: document.getElementById('upgradeDamageBtn'),
    upgradeAttackSpeedBtn: document.getElementById('upgradeAttackSpeedBtn'),
    upgradeHealthBtn: document.getElementById('upgradeHealthBtn'),
    upgradeDefenseBtn: document.getElementById('upgradeDefenseBtn'),
    upgradeNoticeList: document.getElementById('upgradeNoticeList'),
    upgradeReadOnlyPanel: document.getElementById('upgradeReadOnlyPanel'),
    upgradeReadOnlyList: document.getElementById('upgradeReadOnlyList'),
    upgradeSfxToggleBtn: document.getElementById('upgradeSfxToggleBtn'),
    upgradeDamageCard: document.getElementById('upgradeDamageCard'),
    upgradeAttackSpeedCard: document.getElementById('upgradeAttackSpeedCard'),
    upgradeHealthCard: document.getElementById('upgradeHealthCard'),
    upgradeDefenseCard: document.getElementById('upgradeDefenseCard'),
    upgradeDamageBadge: document.getElementById('upgradeDamageBadge'),
    upgradeAttackSpeedBadge: document.getElementById('upgradeAttackSpeedBadge'),
    upgradeHealthBadge: document.getElementById('upgradeHealthBadge'),
    upgradeDefenseBadge: document.getElementById('upgradeDefenseBadge'),
    upgradeDamageBar: document.getElementById('upgradeDamageBar'),
    upgradeAttackSpeedBar: document.getElementById('upgradeAttackSpeedBar'),
    upgradeHealthBar: document.getElementById('upgradeHealthBar'),
    upgradeDefenseBar: document.getElementById('upgradeDefenseBar')
  };

  function fmt(value) {
    return (Number(value) || 0).toLocaleString();
  }

  function nowStamp() {
    const d = new Date();
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s;
  }

  function pushUpgradeNotice(text) {
    state.upgradeNotices.unshift('[' + nowStamp() + '] ' + text);
    if (state.upgradeNotices.length > 20) {
      state.upgradeNotices = state.upgradeNotices.slice(0, 20);
    }
  }

  function renderSegBar(container, level, maxed) {
    if (!container) return;
    container.classList.toggle('maxed', !!maxed);
    container.innerHTML = '';
    for (let i = 0; i < 11; i++) {
      const seg = document.createElement('span');
      if (i < level) seg.classList.add('on');
      container.appendChild(seg);
    }
  }

  function setSfxEnabled(enabled) {
    state.sfxEnabled = !!enabled;
    try {
      localStorage.setItem('warSfxEnabled', state.sfxEnabled ? '1' : '0');
    } catch (_e) {}
    if (els.upgradeSfxToggleBtn) {
      els.upgradeSfxToggleBtn.textContent = 'SFX: ' + (state.sfxEnabled ? 'ON' : 'OFF');
    }
  }

  function playSfx(kind) {
    if (!state.sfxEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = kind === 'success' ? 720 : 220;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.13);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.14);
      osc.onended = function () {
        ctx.close();
      };
    } catch (_e) {}
  }

  function stopTickCountdownTimer() {
    if (state.tickCountdownTimer) {
      clearInterval(state.tickCountdownTimer);
      state.tickCountdownTimer = null;
    }
  }

  function startTickCountdownTimer(nextTickInMs) {
    stopTickCountdownTimer();
    const endsAt = Date.now() + (nextTickInMs || 0);
    function paint() {
      const msLeft = Math.max(0, endsAt - Date.now());
      const secLeft = Math.ceil(msLeft / 1000);
      els.tickCountdownText.textContent = 'Next tick in: ' + secLeft + 's';
      if (msLeft <= 0) {
        stopTickCountdownTimer();
      }
    }
    paint();
    state.tickCountdownTimer = setInterval(paint, 250);
  }

  const territoryDataAdapter = {
    async loadStatic() {
      const res = await fetch(STATIC_TERRITORIES_URL);
      if (!res.ok) throw new Error('Failed to load static territory data');
      return res.json();
    },
    parseTerritories(staticData) {
      const list = [];
      Object.keys(staticData).forEach(function (name) {
        const row = staticData[name] || {};
        const loc = row.Location || row.location;
        if (!loc || !loc.start || !loc.end) return;
        const x1 = loc.start[0];
        const z1 = loc.start[1];
        const x2 = loc.end[0];
        const z2 = loc.end[1];
        list.push({
          name,
          minX: Math.min(x1, x2),
          maxX: Math.max(x1, x2),
          minZ: Math.min(z1, z2),
          maxZ: Math.max(z1, z2),
          guildName: ''
        });
      });
      return list;
    }
  };

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  /**
   * @param {number} imgW
   * @param {number} imgH
   * @returns {object} Leaflet LatLngBounds
   */
  function getImageOverlayBounds(imgW, imgH) {
    const scaledW = imgW * MAP_BG_SCALE_X;
    const scaledH = imgH * MAP_BG_SCALE_Y;
    const minLng = (imgW - scaledW) / 2;
    const maxLng = minLng + scaledW;
    const minLat = (imgH - scaledH) / 2;
    const maxLat = minLat + scaledH;
    return L.latLngBounds([[minLat, minLng], [maxLat, maxLng]]);
  }

  function normalizeKey(name) {
    return String(name)
      .trim()
      .replace(/\u2019/g, "'")
      .replace(/\u2018/g, "'")
      .toLowerCase();
  }

  /**
   * @param {object} liveData
   * @returns {Map<string, string>}
   */
  function buildLiveKeyMap(liveData) {
    const map = new Map();
    Object.keys(liveData).forEach(function (k) {
      map.set(normalizeKey(k), k);
    });
    return map;
  }

  /**
   * @param {string} guildName
   * @returns {string}
   */
  function guildColor(guildName) {
    const label = guildName && String(guildName).trim() ? guildName : 'Unclaimed';
    let h = 0;
    for (let i = 0; i < label.length; i++) {
      h = (h * 31 + label.charCodeAt(i)) >>> 0;
    }
    const hue = h % 360;
    return 'hsl(' + hue + ', 62%, 52%)';
  }

  /**
   * @param {object | null} row
   * @returns {string}
   */
  function guildNameFromLiveRow(row) {
    if (!row || !row.guild || !row.guild.name) return '';
    const n = String(row.guild.name).trim();
    return n;
  }

  /**
   * @param {string} name
   * @param {object} liveData
   * @param {Map<string, string>} liveKeyMap
   * @returns {object | null}
   */
  function resolveLiveRow(name, liveData, liveKeyMap) {
    if (liveData[name]) return liveData[name];
    const canon = liveKeyMap.get(normalizeKey(name));
    return canon ? liveData[canon] : null;
  }

  async function applyLiveOwnership() {
    try {
      const res = await fetch(LIVE_TERRITORIES_URL);
      if (!res.ok) throw new Error('Live territory API ' + res.status);
      const live = await res.json();
      const liveKeyMap = buildLiveKeyMap(live);
      state.territoryByName.forEach(function (t) {
        const row = resolveLiveRow(t.name, live, liveKeyMap);
        t.guildName = guildNameFromLiveRow(row);
      });
    } catch (_e) {
      state.territoryByName.forEach(function (t) {
        t.guildName = '';
      });
    }
    renderSelectionLocally();
  }

  function worldToLayer(x, z) {
    const imgW = state.geo.imgW;
    const imgH = state.geo.imgH;
    const westSpan = Math.abs(MAP_X_MIN) || 1;
    const eastSpan = Math.abs(MAP_X_MAX) || 1;
    const northSpan = Math.abs(MAP_Z_MIN) || 1;
    const southSpan = Math.abs(MAP_Z_MAX) || 1;

    let nx = 0.5;
    if (x < 0) nx = 0.5 - 0.5 * (Math.abs(x) / westSpan);
    else nx = 0.5 + 0.5 * (Math.abs(x) / eastSpan);

    let ny = 1;
    if (z <= 0) ny = 1 - (Math.abs(z) / northSpan);
    else ny = 1 + (Math.abs(z) / southSpan);

    nx = clamp01(nx);
    ny = clamp01(ny);
    if (FLIP_Z) ny = 1 - ny;

    const scaledNx = 0.5 + (nx - 0.5) * MAP_SCALE_X;
    const scaledNy = 0.5 + (ny - 0.5) * MAP_SCALE_Y;
    return L.latLng(
      scaledNy * imgH + MAP_OFFSET_Y_PX,
      scaledNx * imgW + MAP_OFFSET_X_PX
    );
  }

  function boundsFromWorldRect(t) {
    const corners = [
      worldToLayer(t.minX, t.minZ),
      worldToLayer(t.maxX, t.minZ),
      worldToLayer(t.maxX, t.maxZ),
      worldToLayer(t.minX, t.maxZ)
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

  function selectedArray() {
    return Array.from(state.selectedTerritories);
  }

  function setStatus(text) {
    els.statusText.textContent = text;
  }

  /**
   * Socket.io base URL: avoids HTTPS mixed content (never uses http: from an https page).
   * Override with <meta name="eco-war-socket-url" content="https://..."> or window.ECO_WAR_SOCKET_URL.
   * @returns {string}
   */
  function getEcoWarSocketBase() {
    try {
      const el = document.querySelector('meta[name="eco-war-socket-url"]');
      if (el && el.content && String(el.content).trim()) {
        return String(el.content).trim().replace(/\/+$/, '');
      }
    } catch (_e) {}
    if (typeof window.ECO_WAR_SOCKET_URL === 'string' && window.ECO_WAR_SOCKET_URL.trim()) {
      return window.ECO_WAR_SOCKET_URL.trim().replace(/\/+$/, '');
    }
    const host = window.location.hostname || 'localhost';
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    if (isLocal) {
      return 'http://' + host + ':' + SOCKET_DEV_PORT;
    }
    if (window.location.protocol === 'https:') {
      return window.location.origin;
    }
    return 'http://' + host + ':' + SOCKET_DEV_PORT;
  }

  function styleForTerritoryName(name) {
    const selected = state.selectedTerritories.has(name);
    if (selected) {
      return {
        color: '#4da3ff',
        weight: 2,
        fillColor: '#3b82f6',
        fillOpacity: 0.5,
        opacity: 1
      };
    }
    const t = state.territoryByName.get(name);
    const g = t && t.guildName ? String(t.guildName).trim() : '';
    if (!g) {
      return {
        color: 'rgba(180, 180, 190, 0.85)',
        weight: 1,
        fillColor: '#f5f5f7',
        fillOpacity: 0.22,
        opacity: 0.85
      };
    }
    const base = guildColor(g);
    return {
      color: base,
      weight: 1,
      fillColor: base,
      fillOpacity: 0.34,
      opacity: 0.9
    };
  }

  function updateLayerStyle(name) {
    const layer = state.layerByName.get(name);
    if (!layer) return;
    layer.setStyle(styleForTerritoryName(name));
  }

  function renderSelectionLocally() {
    state.layerByName.forEach(function (_layer, name) {
      updateLayerStyle(name);
    });
  }

  function toggleTerritory(name) {
    if (state.role && state.role !== 'defender') return;
    if (!state.armedForDefenderCreate && !state.currentRoom) return;
    if (state.selectedTerritories.has(name)) state.selectedTerritories.delete(name);
    else state.selectedTerritories.add(name);
    renderSelectionLocally();
    lobbyView.renderSelectionSummary();
    socketController.syncSelectionIfAllowed();
  }

  const selectionController = {
    initMapLayers(territories) {
      territories.forEach(function (t) {
        state.territoryByName.set(t.name, t);
        const b = boundsFromWorldRect(t);
        const layer = L.rectangle(b, styleForTerritoryName(t.name));
        layer.on('click', function () {
          toggleTerritory(t.name);
        });
        layer.bindTooltip(t.name, { sticky: true, direction: 'auto' });
        layer.addTo(state.map);
        state.layerByName.set(t.name, layer);
      });
    },
    applyServerSelection(list) {
      state.selectedTerritories = new Set(Array.isArray(list) ? list : []);
      renderSelectionLocally();
      lobbyView.renderSelectionSummary();
    }
  };

  const lobbyView = {
    renderRoom(room) {
      if (!room) return;
      els.lobbyOverlay.style.display = 'block';
      els.roomCodeText.textContent = room.id || '------';
      els.roleText.textContent = 'Role: ' + (state.role || '-');
      els.gameStatusText.textContent = 'Status: ' + room.status;
      els.readyStateText.textContent =
        'Defender ready: ' + room.defenderReady + ' | Attacker ready: ' + room.attackerReady;
      if (typeof room.prepSecondsRemaining === 'number' && room.status === 'prep') {
        els.countdownText.textContent = 'Prep countdown: ' + room.prepSecondsRemaining + 's';
      } else {
        els.countdownText.textContent = 'Prep countdown: -';
      }
      const showResources = room.status === 'prep' || room.status === 'playing' || state.lastTickPayload;
      els.resourcesPanel.style.display = showResources ? 'block' : 'none';
      const showUpgradeButton = room.status === 'playing' && state.role === 'defender';
      els.upgradeMenuBtn.style.display = showUpgradeButton ? 'block' : 'none';
      const showReadOnlyUpgrades = room.status === 'playing';
      els.upgradeReadOnlyPanel.style.display = showReadOnlyUpgrades ? 'block' : 'none';
      upgradeMenuController.renderReadOnlyList(room);
      upgradeMenuController.hydrateTerritoryOptions(room);
      upgradeMenuController.render();
      this.renderSelectionSummary();
      this.updateReadyButton(room);
    },
    renderSelectionSummary() {
      const list = selectedArray();
      els.selectionCountText.textContent = 'Selected territories: ' + list.length;
      els.territoryList.innerHTML = list.slice(0, 30).map(function (name) {
        return '<li>' + name + '</li>';
      }).join('');
    },
    updateReadyButton(room) {
      const canReady = !!(
        room &&
        state.role &&
        room.status === 'lobby' &&
        room.defenderSocketId &&
        room.attackerSocketId
      );
      els.readyBtn.disabled = !canReady;
    },
    renderTick(payload) {
      if (!payload) return;
      const resources = payload.defenderResources || {};
      els.resourcesPanel.style.display = 'block';
      els.resEmeralds.textContent = fmt(resources.emeralds);
      els.resWood.textContent = fmt(resources.wood);
      els.resOre.textContent = fmt(resources.ore);
      els.resCrops.textContent = fmt(resources.crops);
      els.resFish.textContent = fmt(resources.fish);
      const list = Array.isArray(payload.messages) ? payload.messages : [];
      els.tickMessages.innerHTML = list.slice(0, 8).map(function (m) {
        return '<li>' + m + '</li>';
      }).join('');
      if (typeof payload.nextTickInMs === 'number') {
        startTickCountdownTimer(payload.nextTickInMs);
      }
    }
  };

  const upgradeMenuController = {
    hydrateTerritoryOptions(room) {
      const selected = (room && Array.isArray(room.selectedTerritories)) ? room.selectedTerritories : [];
      const prev = state.selectedUpgradeTerritory;
      els.upgradeTerritorySelect.innerHTML = selected.map(function (name) {
        return '<option value="' + name + '">' + name + '</option>';
      }).join('');
      if (selected.length === 0) {
        state.selectedUpgradeTerritory = '';
        return;
      }
      if (prev && selected.indexOf(prev) !== -1) {
        state.selectedUpgradeTerritory = prev;
      } else {
        state.selectedUpgradeTerritory = selected[0];
      }
      els.upgradeTerritorySelect.value = state.selectedUpgradeTerritory;
    },
    getSelectedUpgradeLevel(category) {
      const room = state.currentRoom || {};
      const territory = state.selectedUpgradeTerritory;
      const rows = room.territoryUpgrades || {};
      const level = rows[territory] && Number.isFinite(rows[territory][category])
        ? rows[territory][category]
        : 0;
      return Math.max(0, Math.min(11, parseInt(level || 0, 10) || 0));
    },
    canUpgrade(category) {
      const room = state.currentRoom;
      if (!room || room.status !== 'playing') return false;
      if (state.role !== 'defender') return false;
      if (!state.selectedUpgradeTerritory) return false;
      const level = this.getSelectedUpgradeLevel(category);
      if (level >= 11) return false;
      const cost = UPGRADE_COSTS[category][level + 1] || 0;
      const resourceKey = UPGRADE_RESOURCE_BY_CATEGORY[category];
      const resources = room.defenderResources || {};
      return (resources.emeralds || 0) >= cost && (resources[resourceKey] || 0) >= cost;
    },
    renderCategory(category, cardEl, badgeEl, barEl, metaEl, btnEl) {
      const level = this.getSelectedUpgradeLevel(category);
      const nextCost = level < 11 ? (UPGRADE_COSTS[category][level + 1] || 0) : 0;
      const can = this.canUpgrade(category);
      const maxed = level >= 11;
      metaEl.textContent = level >= 11
        ? 'Level 11 · Maxed'
        : 'Level ' + level + ' · Next cost ' + nextCost + ' ' + UPGRADE_RESOURCE_BY_CATEGORY[category] + ' + ' + nextCost + ' emeralds';
      btnEl.disabled = !can;
      badgeEl.textContent = 'Lv' + level;
      badgeEl.classList.toggle('maxed', maxed);
      renderSegBar(barEl, level, maxed);
      cardEl.classList.remove('state-low', 'state-max');
      if (maxed) cardEl.classList.add('state-max');
      else if (!can) cardEl.classList.add('state-low');
    },
    renderNotices() {
      els.upgradeNoticeList.innerHTML = state.upgradeNotices.map(function (m) {
        return '<li>' + m + '</li>';
      }).join('');
    },
    renderReadOnlyList(room) {
      if (!room || room.status !== 'playing') {
        els.upgradeReadOnlyList.innerHTML = '';
        return;
      }
      const upgrades = room.territoryUpgrades || {};
      const selected = Array.isArray(room.selectedTerritories) ? room.selectedTerritories : [];
      els.upgradeReadOnlyList.innerHTML = selected.map(function (name) {
        const row = upgrades[name] || {};
        const d = parseInt(row.damage || 0, 10) || 0;
        const a = parseInt(row.attackSpeed || 0, 10) || 0;
        const h = parseInt(row.health || 0, 10) || 0;
        const def = parseInt(row.defense || 0, 10) || 0;
        return '<li>' + name + ': D' + d + ' / AS' + a + ' / H' + h + ' / DEF' + def + '</li>';
      }).join('');
    },
    render() {
      const room = state.currentRoom;
      const isDefender = state.role === 'defender';
      els.upgradeRoleHint.textContent = isDefender
        ? 'Defender mode: upgrades are interactive.'
        : 'Attacker view: read-only upgrade levels.';
      this.renderCategory('damage', els.upgradeDamageCard, els.upgradeDamageBadge, els.upgradeDamageBar, els.upgradeDamageMeta, els.upgradeDamageBtn);
      this.renderCategory('attackSpeed', els.upgradeAttackSpeedCard, els.upgradeAttackSpeedBadge, els.upgradeAttackSpeedBar, els.upgradeAttackSpeedMeta, els.upgradeAttackSpeedBtn);
      this.renderCategory('health', els.upgradeHealthCard, els.upgradeHealthBadge, els.upgradeHealthBar, els.upgradeHealthMeta, els.upgradeHealthBtn);
      this.renderCategory('defense', els.upgradeDefenseCard, els.upgradeDefenseBadge, els.upgradeDefenseBar, els.upgradeDefenseMeta, els.upgradeDefenseBtn);
      this.renderNotices();
      if (!room || room.status !== 'playing') {
        els.upgradeDamageBtn.disabled = true;
        els.upgradeAttackSpeedBtn.disabled = true;
        els.upgradeHealthBtn.disabled = true;
        els.upgradeDefenseBtn.disabled = true;
      }
      if (!isDefender) {
        els.upgradeDamageBtn.disabled = true;
        els.upgradeAttackSpeedBtn.disabled = true;
        els.upgradeHealthBtn.disabled = true;
        els.upgradeDefenseBtn.disabled = true;
      }
    },
    open() {
      if (!state.currentRoom || state.currentRoom.status !== 'playing') return;
      els.upgradeModal.style.display = 'flex';
      this.render();
    },
    close() {
      els.upgradeModal.style.display = 'none';
    },
    apply(category) {
      if (!state.currentRoom) return;
      if (!this.canUpgrade(category)) {
        playSfx('error');
        pushUpgradeNotice('Upgrade blocked for ' + category + ' (insufficient resources or maxed)');
        this.renderNotices();
        return;
      }
      state.socket.emit('upgrade:apply', {
        territoryName: state.selectedUpgradeTerritory,
        category
      }, function (resp) {
        if (!resp || !resp.ok) {
          playSfx('error');
          alert((resp && resp.error) || 'Upgrade failed.');
          return;
        }
        playSfx('success');
      });
    }
  };

  const socketController = {
    init() {
      const socketBase = getEcoWarSocketBase();
      state.socket = io(socketBase, { transports: ['websocket', 'polling'] });
      state.socket.on('connect', function () {
        state.connected = true;
        setStatus('Connected to room server');
      });
      state.socket.on('connect_error', function () {
        state.connected = false;
        setStatus(
          'Room server not reachable at ' +
            socketBase +
            '. Use a HTTPS Socket.io host (set meta eco-war-socket-url) or run locally on http://localhost:' +
            SOCKET_DEV_PORT
        );
      });
      state.socket.on('disconnect', function () {
        state.connected = false;
        setStatus('Disconnected from room server');
      });
      state.socket.on('roomError', function (payload) {
        if (payload && payload.error) alert(payload.error);
      });
      state.socket.on('roomState', function (room) {
        state.currentRoom = room;
        if (room && Array.isArray(room.selectedTerritories)) {
          selectionController.applyServerSelection(room.selectedTerritories);
        }
        lobbyView.renderRoom(room);
      });
      state.socket.on('prepTick', function (payload) {
        if (!state.currentRoom) return;
        state.currentRoom.prepSecondsRemaining = payload.secondsRemaining;
        state.currentRoom.status = 'prep';
        lobbyView.renderRoom(state.currentRoom);
      });
      state.socket.on('statusChanged', function (payload) {
        if (!state.currentRoom) return;
        state.currentRoom.status = payload.status;
        lobbyView.renderRoom(state.currentRoom);
      });
      state.socket.on('tick:update', function (payload) {
        state.lastTickPayload = payload;
        lobbyView.renderTick(payload);
      });
      state.socket.on('upgrade:applied', function (payload) {
        const line = payload.territoryName + ' · ' + payload.category + ' -> Lv' + payload.level;
        pushUpgradeNotice(line);
        upgradeMenuController.render();
      });
    },
    createRoom() {
      if (!state.connected) return alert('Socket server is not connected.');
      state.socket.emit('createRoom', {}, function (resp) {
        if (!resp || !resp.ok) {
          alert((resp && resp.error) || 'Failed to create room.');
          return;
        }
        state.role = 'defender';
        state.armedForDefenderCreate = false;
        els.createGameBtn.textContent = 'Create 1v1 Eco War Game';
        setStatus('Room created: ' + resp.roomId);
        socketController.syncSelectionIfAllowed();
      });
    },
    joinRoom(roomId) {
      if (!state.connected) return alert('Socket server is not connected.');
      if (!/^\d{6}$/.test(roomId)) return alert('Room code must be exactly 6 digits.');
      state.socket.emit('joinRoom', { roomId }, function (resp) {
        if (!resp || !resp.ok) {
          alert((resp && resp.error) || 'Failed to join room.');
          return;
        }
        state.role = 'attacker';
        setStatus('Joined room: ' + resp.roomId);
      });
    },
    setReady() {
      if (!state.currentRoom) return;
      const roleKey = state.role === 'defender' ? 'defenderReady' : 'attackerReady';
      const nextReady = !state.currentRoom[roleKey];
      state.socket.emit('setReady', { ready: nextReady }, function (resp) {
        if (!resp || !resp.ok) {
          alert((resp && resp.error) || 'Failed to update ready state.');
        }
      });
    },
    syncSelectionIfAllowed() {
      if (!state.currentRoom || state.role !== 'defender') return;
      state.socket.emit('updateSelection', {
        selectedTerritories: selectedArray()
      }, function (resp) {
        if (resp && resp.ok === false && resp.error) {
          setStatus(resp.error);
        }
      });
    }
  };

  async function initMap() {
    const img = new Image();
    img.src = MAP_IMAGE_URL;
    await new Promise(function (resolve, reject) {
      img.onload = resolve;
      img.onerror = function () {
        reject(new Error('main-map.webp not found for war map'));
      };
    });
    state.geo = { imgW: img.naturalWidth, imgH: img.naturalHeight };
    const bounds = L.latLngBounds([[0, 0], [state.geo.imgH, state.geo.imgW]]);
    const overlayBounds = getImageOverlayBounds(state.geo.imgW, state.geo.imgH);
    state.map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 4,
      zoomSnap: 0.25,
      attributionControl: false
    });
    L.imageOverlay(MAP_IMAGE_URL, overlayBounds).addTo(state.map);
    state.map.fitBounds(bounds);

    const staticData = await territoryDataAdapter.loadStatic();
    const territories = territoryDataAdapter.parseTerritories(staticData);
    selectionController.initMapLayers(territories);
    await applyLiveOwnership();
  }

  function bindUi() {
    els.createGameBtn.addEventListener('click', function () {
      if (!state.role && !state.currentRoom && !state.armedForDefenderCreate) {
        state.armedForDefenderCreate = true;
        els.createGameBtn.textContent = 'Create Room';
        state.role = 'defender';
        setStatus('Defender mode armed. Select territories, then click Create Room.');
        return;
      }
      if (state.armedForDefenderCreate && !state.currentRoom) {
        socketController.createRoom();
        return;
      }
      alert('You are already in a room. Open a new tab for another game.');
    });

    els.joinGameBtn.addEventListener('click', function () {
      const code = (els.joinCodeInput.value || '').trim();
      socketController.joinRoom(code);
    });

    els.readyBtn.addEventListener('click', function () {
      if (!state.currentRoom) return;
      socketController.setReady();
    });

    els.copyCodeBtn.addEventListener('click', async function () {
      const code = els.roomCodeText.textContent || '';
      if (!/^\d{6}$/.test(code)) return;
      try {
        await navigator.clipboard.writeText(code);
        setStatus('Copied room code: ' + code);
      } catch (_e) {
        setStatus('Copy failed. Code: ' + code);
      }
    });

    els.upgradeMenuBtn.addEventListener('click', function () {
      upgradeMenuController.open();
    });

    els.upgradeModalCloseBtn.addEventListener('click', function () {
      upgradeMenuController.close();
    });

    els.upgradeModal.addEventListener('click', function (ev) {
      if (ev.target === els.upgradeModal) {
        upgradeMenuController.close();
      }
    });

    els.upgradeTerritorySelect.addEventListener('change', function () {
      state.selectedUpgradeTerritory = els.upgradeTerritorySelect.value || '';
      upgradeMenuController.render();
    });

    els.upgradeDamageBtn.addEventListener('click', function () {
      upgradeMenuController.apply('damage');
    });
    els.upgradeAttackSpeedBtn.addEventListener('click', function () {
      upgradeMenuController.apply('attackSpeed');
    });
    els.upgradeHealthBtn.addEventListener('click', function () {
      upgradeMenuController.apply('health');
    });
    els.upgradeDefenseBtn.addEventListener('click', function () {
      upgradeMenuController.apply('defense');
    });
    els.upgradeSfxToggleBtn.addEventListener('click', function () {
      setSfxEnabled(!state.sfxEnabled);
    });
  }

  async function init() {
    try {
      const saved = localStorage.getItem('warSfxEnabled');
      if (saved === '0') setSfxEnabled(false);
      else setSfxEnabled(true);
    } catch (_e) {
      setSfxEnabled(true);
    }
    bindUi();
    socketController.init();
    try {
      await initMap();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to initialize war map';
      setStatus(msg);
    }
  }

  init();
})();
