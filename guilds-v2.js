const GUILD_API = '/api/guild';
const GUILD_EVENTS_API = '/api/guild/events';
const USER_API = '/api/user';
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;
const WYNN_PLAYER_WARS_SPACING_MS = 850;
const WYNN_PLAYER_WARS_429_BACKOFF_MS = 3200;
const MEMBER_WARS_INITIAL_HYDRATE_LIMIT = 32;

function isWarDebugVerbose() {
  try {
    return localStorage.getItem('wynnDebugWars') === '1';
  } catch {
    return false;
  }
}

function warLog(message, data) {
  if (data !== undefined) {
    console.info('[wynn-wars]', message, data);
  } else {
    console.info('[wynn-wars]', message);
  }
}

function warLogVerbose(message, data) {
  if (!isWarDebugVerbose()) return;
  if (data !== undefined) {
    console.log('[wynn-wars:verbose]', message, data);
  } else {
    console.log('[wynn-wars:verbose]', message);
  }
}

let nextPlayerWarsRequestAt = 0;
let currentUser = null;
let currentGuild = null;
let activeEvent = null;
let cooldownTimerId = null;
const memberWarsCache = new Map();
let memberWarsHydrateSession = 0;
let guildResultCollapsed = false;
const isSearchPage = window.location.pathname.startsWith('/guild/search');

function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttlePlayerWarsRequest() {
  const now = Date.now();
  const waitMs = Math.max(0, nextPlayerWarsRequestAt - now);
  if (waitMs > 0) {
    warLogVerbose('throttle wait ms', waitMs);
    await delay(waitMs);
  }
  nextPlayerWarsRequestAt = Date.now() + WYNN_PLAYER_WARS_SPACING_MS;
}

function logout() {
  localStorage.removeItem('currentUser');
  localStorage.removeItem('userHash');
  currentUser = null;
  window.location.href = '/guild';
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function debugLog(runId, hypothesisId, location, message, data) {
  const payload = {
    sessionId: '0353be',
    runId,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now()
  };
  console.debug('[agent-debug]', payload);
  const host = window.location.hostname;
  const isLocalDebugHost = host === 'localhost' || host === '127.0.0.1';
  if (!isLocalDebugHost) return;
  fetch('http://127.0.0.1:7649/ingest/d9a33132-748f-4430-83b4-30759d15d7c7', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': '0353be'
    },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

async function loadUserData(options = {}) {
  if (!currentUser) return null;
  const includeEvents = Boolean(options.includeEvents);
  try {
    const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(currentUser)}&includeEvents=${includeEvents ? 'true' : 'false'}`);
    if (!response.ok) throw new Error('Failed to load user data');
    return await response.json();
  } catch (e) {
    console.error('Load user data error:', e);
    return null;
  }
}

async function updateUserData(payload) {
  if (!currentUser) return false;
  try {
    const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(currentUser)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      let errorData = {};
      try {
        errorData = await response.json();
      } catch {
        errorData = { error: 'unknown' };
      }
      return { ok: false, status: response.status, error: errorData?.error || 'unknown' };
    }
    return { ok: true };
  } catch (e) {
    console.error('Update user data error:', e);
    return { ok: false, status: 0, error: e.message };
  }
}

function collectGuildMembers(guild) {
  if (!guild?.members) return [];
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const players = [];
  for (const rank of ranks) {
    if (!guild.members[rank]) continue;
    for (const [memberUuid, member] of Object.entries(guild.members[rank])) {
      players.push({
        uuid: member.uuid || memberUuid || null,
        username: member.username,
        contributed: Number(member.contributed || 0),
        wars: memberWarsCache.get(member.uuid || memberUuid || '') ?? null
      });
    }
  }
  return players;
}

function buildPlayerMap(players) {
  const map = {};
  for (const player of players) {
    map[player.username] = {
      xp: Number(player.contributed || 0),
      wars: Number(player.wars || 0)
    };
  }
  return map;
}

function formatDelta(value) {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${Number(value || 0).toLocaleString()}`;
}

function formatScope(scope) {
  return scope === 'guild' ? 'Entire Guild' : 'Selected Players';
}

function formatMetric(metric) {
  return metric === 'wars' ? 'Wars' : 'Guild XP';
}

function formatWarsSuffix(showWars, wars) {
  if (!showWars) return ' · ... Wars';
  if (wars == null) return ' · ⏳ Loading wars';
  return ` · ${Number(wars).toLocaleString()} Wars`;
}

function showMemberWarsEnabled() {
  const toggle = document.getElementById('showMemberWarsToggle');
  return Boolean(toggle?.checked);
}

function normalizeActiveEvent(rawEvent, fallbackTrackedPlayers = []) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  if (rawEvent.metric && rawEvent.startedAt && rawEvent.baseline) {
    return rawEvent;
  }

  const metric = rawEvent.type === 'wars' ? 'wars' : 'xp';
  const startedAt = Number(rawEvent.startTime || Date.now());
  const startValue = Number(rawEvent.startValue || 0);
  const updates = Array.isArray(rawEvent.updates) ? rawEvent.updates : [];
  const latestUpdate = updates.length ? updates[updates.length - 1] : null;
  const currentValue = Number(latestUpdate?.value ?? startValue);
  const trackedPlayers = Array.isArray(rawEvent.trackedPlayers)
    ? rawEvent.trackedPlayers
    : (Array.isArray(fallbackTrackedPlayers) ? fallbackTrackedPlayers : []);
  const lastRefreshAt = Number(rawEvent.lastRefreshAt || latestUpdate?.time || startedAt);
  const firstRefreshDone = rawEvent.firstRefreshDone === undefined
    ? lastRefreshAt > startedAt
    : Boolean(rawEvent.firstRefreshDone);

  return {
    guildName: rawEvent.guildName || null,
    metric,
    scope: rawEvent.scope || 'selected',
    trackedPlayers,
    refreshCooldownMs: Number(rawEvent.refreshCooldownMs || REFRESH_COOLDOWN_MS),
    startedAt,
    lastRefreshAt,
    firstRefreshDone,
    eventCode: typeof rawEvent.eventCode === 'string' ? rawEvent.eventCode.toUpperCase() : null,
    isPublic: Boolean(rawEvent.isPublic),
    baseline: rawEvent.baseline || {
      metricValue: startValue,
      playerValues: {}
    },
    current: rawEvent.current || {
      metricValue: currentValue,
      playerValues: {}
    }
  };
}

function displayGuild(guild) {
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  document.getElementById('guildName').textContent = guild.name || 'Unknown';
  document.getElementById('guildPrefix').textContent = guild.prefix ? `[${guild.prefix}]` : '[No Prefix]';
  document.getElementById('guildLevel').textContent = guild.level || 0;
  document.getElementById('guildWars').textContent = guild.wars ?? 0;
  document.getElementById('guildTerritories').textContent = guild.territories || 0;
  document.getElementById('guildMembers').textContent = guild.members?.total || 0;
  document.getElementById('guildXp').textContent = `${guild.xpPercent || 0}%`;

  const members = collectGuildMembers(guild);
  renderMembersList(members);
  renderPlayerSelection(members);

  guildResult.classList.remove('hidden');
  noResult.classList.add('hidden');
  updateGuildResultCollapseUI();
}

function updateGuildResultCollapseUI() {
  const body = document.getElementById('guildResultBody');
  const toggleBtn = document.getElementById('toggleGuildResultBtn');
  if (!body || !toggleBtn) return;
  body.classList.toggle('hidden', guildResultCollapsed);
  toggleBtn.textContent = guildResultCollapsed ? 'Expand' : 'Minimize';
}

function renderMembersList(players) {
  const listEl = document.getElementById('guildMembersList');
  const showWars = showMemberWarsEnabled();
  if (!players.length) {
    listEl.innerHTML = '<p class="text-gray-500 text-sm">No members</p>';
    return;
  }
  listEl.innerHTML = players.map((player) => `
    <div class="flex justify-between items-center bg-gray-800/30 px-3 py-2 rounded text-sm">
      <span class="text-white font-medium">${escapeHtml(player.username)}</span>
      <span class="text-gray-400">${Number(player.contributed).toLocaleString()} XP${formatWarsSuffix(showWars, player.wars)}</span>
    </div>
  `).join('');
}

function renderPlayerSelection(players) {
  const container = document.getElementById('playerCheckboxes');
  const showWars = showMemberWarsEnabled();
  // #region agent log
  debugLog('pre-fix', 'H5', 'guilds-v2.js:renderPlayerSelection', 'rendering player selection wars state', { players: players.length, showWars, resolvedWars: players.filter((p) => p.wars != null).length, placeholderWars: players.filter((p) => p.wars == null).length });
  // #endregion
  if (!players.length) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No members available</p>';
    return;
  }
  container.innerHTML = players.map((player) => `
    <label class="flex items-center gap-2 p-2 hover:bg-gray-800/50 rounded cursor-pointer">
      <input type="checkbox" value="${escapeHtml(player.username)}" class="accent-purple-500">
      <span class="text-white text-sm">${escapeHtml(player.username)}</span>
      <span class="text-gray-500 text-xs ml-auto">${Number(player.contributed).toLocaleString()} XP${formatWarsSuffix(showWars, player.wars)}</span>
    </label>
  `).join('');
}

function hideAmbiguousGuildResults() {
  const box = document.getElementById('guildAmbiguousResult');
  if (box) box.classList.add('hidden');
}

function normalizeAmbiguousOptions(options) {
  if (!options || typeof options !== 'object') return [];
  return Object.entries(options).map(([key, value]) => {
    if (value && typeof value === 'object') {
      return {
        key,
        name: value.name || key,
        prefix: value.prefix || key,
        stats: value
      };
    }
    return {
      key,
      name: String(value || key),
      prefix: key,
      stats: {}
    };
  });
}

function renderAmbiguousGuildResults(query, searchType, options) {
  const box = document.getElementById('guildAmbiguousResult');
  const list = document.getElementById('guildAmbiguousList');
  const meta = document.getElementById('guildAmbiguousMeta');
  if (!box || !list || !meta) return;

  const normalized = normalizeAmbiguousOptions(options);
  meta.textContent = `Query "${query}" matched ${normalized.length} guilds (${searchType})`;
  if (!normalized.length) {
    list.innerHTML = '<p class="text-sm text-gray-500">No options.</p>';
    box.classList.remove('hidden');
    return;
  }

  list.innerHTML = normalized.map((option) => {
    const level = option.stats?.level != null ? `Lv.${option.stats.level}` : '';
    const wars = option.stats?.wars != null ? `${option.stats.wars} wars` : '';
    return `
      <button type="button" class="w-full text-left bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700 rounded p-3 transition-colors guild-ambiguous-option" data-prefix="${escapeHtml(option.prefix)}">
        <div class="flex items-center justify-between">
          <span class="text-white font-medium">${escapeHtml(option.name)}</span>
          <span class="text-violet-300 text-sm">[${escapeHtml(option.prefix)}]</span>
        </div>
        <p class="text-xs text-gray-400 mt-1">${escapeHtml([level, wars].filter(Boolean).join(' · ') || 'Select this guild')}</p>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.guild-ambiguous-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prefix = btn.getAttribute('data-prefix') || '';
      searchGuild(prefix, 'prefix');
    });
  });

  box.classList.remove('hidden');
}

function getSelectedPlayers() {
  const checked = document.querySelectorAll('#playerCheckboxes input[type="checkbox"]:checked');
  return Array.from(checked).map((el) => el.value);
}

function getSnapshot(metric, guild, trackedPlayers, scope = 'selected') {
  const players = collectGuildMembers(guild);
  const playerMap = buildPlayerMap(players);
  const selected = trackedPlayers.length ? trackedPlayers : players.map((p) => p.username);
  const snapshotPlayers = {};
  for (const username of selected) {
    const entry = playerMap[username] || { xp: 0, wars: 0 };
    snapshotPlayers[username] = Number(metric === 'wars' ? entry.wars : entry.xp);
  }
  const selectedTotal = Object.values(snapshotPlayers).reduce((sum, value) => sum + Number(value || 0), 0);
  const metricValue = metric === 'wars'
    ? (scope === 'selected' ? selectedTotal : Number(guild.wars || 0))
    : (scope === 'selected' ? selectedTotal : Number(guild.xpPercent || 0));
  if (metric === 'wars') {
    // #region agent log
    console.log('[wars-snapshot]', {
      metric,
      scopeHint: trackedPlayers.length ? 'selected' : 'guild',
      scope,
      trackedPlayersCount: trackedPlayers.length,
      selectedTotal,
      metricValueUsedByCard: metricValue,
      samplePlayers: Object.entries(snapshotPlayers).slice(0, 5)
    });
    // #endregion
  }
  // #region agent log
  debugLog('pre-fix', 'H6', 'guilds-v2.js:getSnapshot:metricSource', 'snapshot metric source comparison', { metric, selectedCount: selected.length, metricValue, selectedTotal, selectedPlayers: selected.slice(0, 5), samplePlayers: Object.entries(snapshotPlayers).slice(0, 3), guildWars: Number(guild?.wars || 0), guildXp: Number(guild?.xpPercent || 0) });
  // #endregion
  return {
    metricValue,
    playerValues: snapshotPlayers,
    capturedAt: Date.now()
  };
}

async function fetchMemberWars(uuid, forceRefresh = false) {
  const uuidShort = typeof uuid === 'string' && uuid.length > 12 ? `${uuid.slice(0, 8)}…` : uuid;
  if (!uuid) {
    warLogVerbose('fetchMemberWars skipped', 'missing uuid');
    return null;
  }
  if (!forceRefresh && memberWarsCache.has(uuid)) {
    warLogVerbose('fetchMemberWars cache hit', { uuid: uuidShort });
    return memberWarsCache.get(uuid);
  }
  try {
    const doFetch = async () => {
      await throttlePlayerWarsRequest();
      return fetch(`/api/player/wars?uuid=${encodeURIComponent(uuid)}`);
    };
    let response = await doFetch();
    warLogVerbose('fetchMemberWars response', { uuid: uuidShort, status: response.status, ok: response.ok });
    // #region agent log
    debugLog('pre-fix', 'H3', 'guilds-v2.js:fetchMemberWars:response', 'player endpoint response status', { uuid, ok: response.ok, status: response.status });
    // #endregion
    if (response.status === 429) {
      warLog('429 from proxy, backing off then retry', { uuid: uuidShort });
      await delay(WYNN_PLAYER_WARS_429_BACKOFF_MS);
      response = await doFetch();
      warLogVerbose('fetchMemberWars retry response', { uuid: uuidShort, status: response.status, ok: response.ok });
    }
    if (!response.ok) {
      let errDetail = '';
      try {
        const errJson = await response.json();
        errDetail = errJson?.error || JSON.stringify(errJson);
      } catch {
        try {
          errDetail = (await response.text()).slice(0, 200);
        } catch {
          errDetail = '';
        }
      }
      warLog('fetchMemberWars failed', { uuid: uuidShort, status: response.status, detail: errDetail || '(no body)' });
      return null;
    }
    const data = await response.json();
    const wars = Number(data?.wars || 0);
    // #region agent log
    debugLog('pre-fix', 'H1', 'guilds-v2.js:fetchMemberWars:parsed', 'parsed wars payload fields', { uuid, wars, hasGlobalData: Boolean(data?.globalData), globalDataKeys: data?.globalData ? Object.keys(data.globalData).slice(0, 8) : [] });
    // #endregion
    memberWarsCache.set(uuid, wars);
    warLogVerbose('fetchMemberWars ok', { uuid: uuidShort, wars });
    return wars;
  } catch (err) {
    warLog('fetchMemberWars threw', { uuid: uuidShort, message: err?.message || String(err) });
    // #region agent log
    debugLog('pre-fix', 'H3', 'guilds-v2.js:fetchMemberWars:catch', 'player endpoint fetch threw', { uuid });
    // #endregion
    return null;
  }
}

async function hydrateVisibleMemberWars(guild, forceRefresh = false, usernames = null, sessionId = null) {
  if (!guild) {
    warLog('hydrateVisibleMemberWars skipped', 'no guild');
    return;
  }
  const members = collectGuildMembers(guild);
  const wantedUsernames = Array.isArray(usernames) ? new Set(usernames) : null;
  const targets = members.filter((member) => {
    if (!member.uuid) return false;
    if (wantedUsernames && !wantedUsernames.has(member.username)) return false;
    if (forceRefresh) return true;
    return !memberWarsCache.has(member.uuid);
  });
  const applyInitialLimit = !forceRefresh && !wantedUsernames;
  const limitedTargets = applyInitialLimit
    ? targets.slice(0, MEMBER_WARS_INITIAL_HYDRATE_LIMIT)
    : targets;
  const missingUuid = members.filter((m) => !m.uuid).length;
  warLog('hydrateVisibleMemberWars', {
    guildName: guild.name || '(unknown)',
    totalMembers: members.length,
    targets: targets.length,
    processingTargets: limitedTargets.length,
    deferredTargets: Math.max(0, targets.length - limitedTargets.length),
    missingUuid,
    forceRefresh,
    filterUsernames: wantedUsernames ? wantedUsernames.size : null
  });
  // #region agent log
  debugLog('pre-fix', 'H2', 'guilds-v2.js:hydrateVisibleMemberWars:targets', 'member uuid coverage', { totalMembers: members.length, targets: targets.length, missingUuid: members.filter((m) => !m.uuid).length });
  // #endregion
  if (!limitedTargets.length) {
    warLog('hydrateVisibleMemberWars nothing to fetch', { reason: 'all cached or no uuids matched filter' });
    return;
  }
  let idx = 0;
  for (const member of limitedTargets) {
    if (sessionId != null && sessionId !== memberWarsHydrateSession) {
      warLog('hydrateVisibleMemberWars aborted', { sessionId, reason: 'superseded by newer search' });
      return;
    }
    idx += 1;
    warLogVerbose(`hydrate fetch ${idx}/${limitedTargets.length}`, { user: member.username });
    await fetchMemberWars(member.uuid, forceRefresh);
  }
  warLog('hydrateVisibleMemberWars done', { fetched: limitedTargets.length });
}

function generateEventCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

async function upsertEventCodeIndex(event) {
  if (!currentUser || !event?.eventCode) return { ok: false, error: 'Missing user or code' };
  try {
    const response = await fetch(GUILD_EVENTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'upsert',
        username: currentUser,
        code: event.eventCode,
        event
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, error: data?.error || 'Failed to upsert event code' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function updateEventVisibility(eventCode, isPublic) {
  if (!currentUser || !eventCode) return { ok: false, error: 'Missing user or code' };
  try {
    const response = await fetch(GUILD_EVENTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'visibility',
        username: currentUser,
        code: eventCode,
        isPublic
      })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return { ok: false, status: response.status, error: data?.error || 'Failed to update visibility' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

async function removeEventCodeIndex(eventCode) {
  if (!currentUser || !eventCode) return { ok: true };
  try {
    await fetch(GUILD_EVENTS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'remove',
        username: currentUser,
        code: eventCode
      })
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function openLeaderboardPage() {
  const code = activeEvent?.eventCode;
  if (code) {
    window.location.href = `/guild/leaderboard?code=${encodeURIComponent(code)}`;
    return;
  }
  window.location.href = '/guild/leaderboard';
}

function openLeaderboardByCode(rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return;
  window.location.href = `/guild/leaderboard?code=${encodeURIComponent(code)}`;
}

function toggleDashboardCodePanel(forceOpen = null) {
  const panel = document.getElementById('dashboardJoinCodeSection');
  if (!panel) return;
  const nextOpen = forceOpen === null ? panel.classList.contains('hidden') : Boolean(forceOpen);
  panel.classList.toggle('hidden', !nextOpen);
  if (nextOpen) {
    document.getElementById('dashboardEventCodeInput')?.focus();
  }
}

function setDashboardEventLoading(isLoading, message = 'Loading event data...') {
  const loadingEl = document.getElementById('dashboardEventLoadingText');
  if (!loadingEl) return;
  loadingEl.textContent = message;
  loadingEl.classList.toggle('hidden', !isLoading);
}

function updateStopTrackingState() {
  const stopBtn = document.getElementById('stopTrackingBtn');
  if (!stopBtn) return;
  const hasActiveEvent = Boolean(activeEvent);
  stopBtn.disabled = hasActiveEvent;
  stopBtn.title = hasActiveEvent ? 'End the active event first' : 'Stop tracking this guild';
}

function getGuildDelta(event) {
  const start = Number(event.baseline?.metricValue || 0);
  const current = Number(event.current?.metricValue || start);
  return current - start;
}

function updateCooldownText() {
  if (!activeEvent) return;
  const refreshBtn = document.getElementById('refreshEventBtn');
  const dashboardRefreshBtn = document.getElementById('dashboardRefreshBtn');
  const eventCooldownText = document.getElementById('eventCooldownText');
  const dashboardCooldownText = document.getElementById('dashboardCooldownText');
  if (!refreshBtn || !dashboardRefreshBtn || !eventCooldownText || !dashboardCooldownText) return;
  const firstRefreshDone = Boolean(activeEvent.firstRefreshDone);
  const lastRefreshAt = Number(activeEvent.lastRefreshAt || activeEvent.startedAt || 0);
  const remaining = firstRefreshDone
    ? Math.max(0, (lastRefreshAt + Number(activeEvent.refreshCooldownMs || REFRESH_COOLDOWN_MS)) - Date.now())
    : 0;

  if (remaining === 0) {
    refreshBtn.disabled = false;
    dashboardRefreshBtn.disabled = false;
    eventCooldownText.textContent = 'Refresh available now';
    dashboardCooldownText.textContent = 'Refresh available now';
  } else {
    const mins = Math.ceil(remaining / 60000);
    refreshBtn.disabled = true;
    dashboardRefreshBtn.disabled = true;
    eventCooldownText.textContent = `Refresh available in ${mins} minute${mins === 1 ? '' : 's'}`;
    dashboardCooldownText.textContent = eventCooldownText.textContent;
  }
}

function startCooldownTicker() {
  if (cooldownTimerId) window.clearInterval(cooldownTimerId);
  cooldownTimerId = window.setInterval(() => {
    updateCooldownText();
    renderActiveEvent();
  }, 1000);
}

function stopCooldownTicker() {
  if (cooldownTimerId) {
    window.clearInterval(cooldownTimerId);
    cooldownTimerId = null;
  }
}

function renderTrackedPlayersInfo(players) {
  const container = document.getElementById('trackedPlayersInfo');
  if (!players || !players.length) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No selected players saved.</p>';
    return;
  }
  const maxPreview = 5;
  const visiblePlayers = players.slice(0, maxPreview);
  const remaining = Math.max(0, players.length - visiblePlayers.length);
  container.innerHTML = visiblePlayers.map((username) => `
    <div class="bg-gray-800/50 rounded p-2 text-sm inline-block mr-2 mb-2">
      <span class="text-white font-medium">${escapeHtml(username)}</span>
    </div>
  `).join('') + (remaining > 0
    ? `<div class="bg-gray-800/40 rounded p-2 text-sm inline-block mr-2 mb-2"><span class="text-gray-300 font-medium">... +${remaining} more</span></div>`
    : '');
}

function renderEventPlayerBreakdown(event, idPrefix = '') {
  const base = idPrefix ? `${idPrefix}EventPlayerBreakdown` : 'eventPlayerBreakdown';
  const section = document.getElementById(`${base}Section`);
  const meta = document.getElementById(`${base}Meta`);
  const list = document.getElementById(`${base}List`);
  if (!section || !meta || !list) return;

  const baselinePlayers = event?.baseline?.playerValues || {};
  const currentPlayers = event?.current?.playerValues || baselinePlayers;
  const rows = Object.keys(currentPlayers).map((username) => {
    const startValue = Number(baselinePlayers[username] || 0);
    const currentValue = Number(currentPlayers[username] || startValue);
    const deltaValue = currentValue - startValue;
    return { username, startValue, currentValue, deltaValue };
  }).sort((a, b) => b.deltaValue - a.deltaValue);

  if (!rows.length) {
    section.classList.add('hidden');
    list.innerHTML = '<p class="text-sm text-gray-500">No player data yet.</p>';
    return;
  }

  const metricLabel = event.metric === 'wars' ? 'Wars' : 'XP';
  meta.textContent = `${rows.length} players · ${metricLabel}`;
  list.innerHTML = rows.map((row, index) => `
    <div class="grid grid-cols-12 gap-2 items-center text-xs bg-gray-800/40 rounded px-2 py-1">
      <div class="col-span-4 text-white truncate" title="${escapeHtml(row.username)}">#${index + 1} ${escapeHtml(row.username)}</div>
      <div class="col-span-3 text-gray-400 text-right">${row.startValue.toLocaleString()}</div>
      <div class="col-span-3 text-gray-300 text-right">${row.currentValue.toLocaleString()}</div>
      <div class="col-span-2 text-right ${row.deltaValue >= 0 ? 'text-green-400' : 'text-red-400'}">${formatDelta(row.deltaValue)}</div>
    </div>
  `).join('');
  section.classList.remove('hidden');
}

function renderActiveEvent() {
  const hasEvent = Boolean(activeEvent);
  const quickCodeRow = document.getElementById('dashboardQuickEventCodeRow');
  const quickCodeValue = document.getElementById('dashboardQuickEventCodeValue');
  document.getElementById('activeEventSection').classList.toggle('hidden', !hasEvent);
  document.getElementById('dashboardEventSection').classList.toggle('hidden', !hasEvent);
  document.getElementById('eventSetupSection').classList.toggle('hidden', hasEvent);
  document.getElementById('startEventBtn').classList.toggle('hidden', hasEvent);
  document.getElementById('noActiveEventSection').classList.toggle('hidden', hasEvent);
  if (quickCodeRow) {
    quickCodeRow.classList.toggle('hidden', !hasEvent);
  }

  if (!hasEvent) {
    if (quickCodeValue) {
      quickCodeValue.textContent = '-';
    }
    updateStopTrackingState();
    return;
  }

  const elapsed = Date.now() - Number(activeEvent.startedAt || Date.now());
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const durationText = `${hours}h ${minutes}m ${seconds}s`;
  const delta = getGuildDelta(activeEvent);
  const startValue = Number(activeEvent.baseline?.metricValue || 0);
  const currentValue = Number(activeEvent.current?.metricValue || startValue);
  if (activeEvent.metric === 'wars') {
    // #region agent log
    console.log('[wars-render]', {
      scope: activeEvent.scope,
      trackedPlayers: (activeEvent.trackedPlayers || []).slice(0, 10),
      startValue,
      currentValue,
      baselineSample: Object.entries(activeEvent.baseline?.playerValues || {}).slice(0, 5),
      currentSample: Object.entries(activeEvent.current?.playerValues || {}).slice(0, 5)
    });
    // #endregion
  }

  document.getElementById('eventDuration').textContent = durationText;
  document.getElementById('dashboardEventDuration').textContent = durationText;
  document.getElementById('eventMetric').textContent = formatMetric(activeEvent.metric);
  document.getElementById('dashboardEventMetric').textContent = formatMetric(activeEvent.metric);
  document.getElementById('eventScope').textContent = formatScope(activeEvent.scope);
  document.getElementById('dashboardEventScope').textContent = formatScope(activeEvent.scope);
  const startLabelEl = document.getElementById('eventStartLabel');
  const currentLabelEl = document.getElementById('eventCurrentLabel');
  const dashboardStartLabelEl = document.getElementById('dashboardEventStartLabel');
  const dashboardCurrentLabelEl = document.getElementById('dashboardEventCurrentLabel');
  if (startLabelEl && currentLabelEl) {
    if (activeEvent.metric === 'wars') {
      startLabelEl.textContent = 'Total Wars (Start)';
      currentLabelEl.textContent = 'Total Wars (Now)';
      if (dashboardStartLabelEl && dashboardCurrentLabelEl) {
        dashboardStartLabelEl.textContent = 'Total Wars (Start)';
        dashboardCurrentLabelEl.textContent = 'Total Wars (Now)';
      }
    } else if (activeEvent.metric === 'xp') {
      startLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player XP (Start)' : 'Guild XP % (Start)';
      currentLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player XP (Now)' : 'Guild XP % (Now)';
      if (dashboardStartLabelEl && dashboardCurrentLabelEl) {
        dashboardStartLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player XP (Start)' : 'Guild XP % (Start)';
        dashboardCurrentLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player XP (Now)' : 'Guild XP % (Now)';
      }
    } else {
      startLabelEl.textContent = 'Start Value';
      currentLabelEl.textContent = 'Current Value';
      if (dashboardStartLabelEl && dashboardCurrentLabelEl) {
        dashboardStartLabelEl.textContent = 'Start Value';
        dashboardCurrentLabelEl.textContent = 'Current Value';
      }
    }
  }
  document.getElementById('eventStartValue').textContent = startValue.toLocaleString();
  document.getElementById('dashboardEventStartValue').textContent = startValue.toLocaleString();
  document.getElementById('eventCurrentValue').textContent = currentValue.toLocaleString();
  document.getElementById('dashboardEventCurrentValue').textContent = currentValue.toLocaleString();
  document.getElementById('eventDelta').textContent = formatDelta(delta);
  document.getElementById('dashboardEventDelta').textContent = formatDelta(delta);
  const eventCodeDisplay = document.getElementById('eventCodeDisplay');
  const dashboardEventCodeDisplay = document.getElementById('dashboardEventCodeDisplay');
  const activeEventPublicToggle = document.getElementById('activeEventPublicToggle');
  const dashboardActiveEventPublicToggle = document.getElementById('dashboardActiveEventPublicToggle');
  if (eventCodeDisplay) {
    eventCodeDisplay.textContent = activeEvent.eventCode || '-';
  }
  if (dashboardEventCodeDisplay) {
    dashboardEventCodeDisplay.textContent = activeEvent.eventCode || '-';
  }
  if (quickCodeValue) {
    quickCodeValue.textContent = activeEvent.eventCode || '-';
  }
  if (activeEventPublicToggle) {
    activeEventPublicToggle.checked = Boolean(activeEvent.isPublic);
    activeEventPublicToggle.disabled = !activeEvent.eventCode;
  }
  if (dashboardActiveEventPublicToggle) {
    dashboardActiveEventPublicToggle.checked = Boolean(activeEvent.isPublic);
    dashboardActiveEventPublicToggle.disabled = !activeEvent.eventCode;
  }
  renderEventPlayerBreakdown(activeEvent);
  renderEventPlayerBreakdown(activeEvent, 'dashboard');

  updateCooldownText();
  updateStopTrackingState();
}

async function searchGuild(name, mode = 'auto', options = {}) {
  const shouldRender = options.render !== false;
  const hydrateWars = options.hydrateWars !== undefined ? options.hydrateWars : isSearchPage;
  warLog('searchGuild', {
    query: (name || '').slice(0, 40),
    mode,
    shouldRender,
    hydrateWars,
    isSearchPage,
    path: window.location.pathname
  });
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  if (!name || !name.trim()) return;

  if (shouldRender) {
    if (guildResult) guildResult.classList.add('hidden');
    if (noResult) noResult.classList.add('hidden');
    hideAmbiguousGuildResults();
  }

  try {
    const response = await fetch(`${GUILD_API}?query=${encodeURIComponent(name)}&mode=${encodeURIComponent(mode)}`);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 300 && data?.ambiguous) {
      if (shouldRender) {
        renderAmbiguousGuildResults(name, data.searchType || mode, data.options || {});
      }
      return;
    }

    if (!response.ok) {
      if (response.status === 404) {
        if (shouldRender && noResult) {
          noResult.classList.remove('hidden');
        }
        currentGuild = null;
        return;
      }
      throw new Error(`API Error: ${response.status}`);
    }
    currentGuild = data;
    if (shouldRender) {
      displayGuild(currentGuild);
    }
    if (hydrateWars) {
      memberWarsHydrateSession += 1;
      const sid = memberWarsHydrateSession;
      const guildRef = data;
      void (async () => {
        try {
          await hydrateVisibleMemberWars(guildRef, false, null, sid);
          if (sid !== memberWarsHydrateSession) return;
          if (shouldRender && currentGuild && currentGuild.name === guildRef.name) {
            displayGuild(currentGuild);
          }
        } catch (err) {
          console.error('Background war hydrate error:', err);
        }
      })();
    } else if (shouldRender && currentGuild?.name === data?.name) {
      displayGuild(currentGuild);
    }
  } catch (e) {
    console.error('Search error:', e);
    if (shouldRender) {
      alert(`Error searching guild: ${e.message}`);
    }
  }
}

async function startEvent() {
  if (!currentUser) {
    alert('Please log in first.');
    return;
  }
  if (!currentGuild?.name) {
    alert('Search and load a guild first.');
    return;
  }
  if (activeEvent) {
    alert('Only one active event is allowed.');
    return;
  }

  const metric = document.getElementById('trackMetricSelect').value;
  const scope = document.getElementById('trackScopeSelect').value;
  const eventPublicToggle = document.getElementById('eventPublicToggle');
  const isPublic = Boolean(eventPublicToggle?.checked);
  let trackedPlayers = [];
  if (scope === 'selected') {
    trackedPlayers = getSelectedPlayers();
    if (!trackedPlayers.length) {
      alert('Select at least one player or choose Entire Guild.');
      return;
    }
  } else {
    trackedPlayers = collectGuildMembers(currentGuild).map((p) => p.username);
  }

  const baseline = getSnapshot(metric, currentGuild, trackedPlayers, scope);
  let eventCode = null;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    const candidate = generateEventCode();
    const reserveResult = await upsertEventCodeIndex({
      eventCode: candidate,
      isPublic,
      guildName: currentGuild.name,
      metric,
      scope,
      trackedPlayers,
      refreshCooldownMs: REFRESH_COOLDOWN_MS,
      startedAt: Date.now(),
      lastRefreshAt: Date.now(),
      firstRefreshDone: false,
      baseline,
      current: baseline
    });
    if (reserveResult.ok) {
      eventCode = candidate;
      break;
    }
    if (reserveResult.status !== 409) {
      alert(`Failed to reserve event code: ${reserveResult.error}`);
      return;
    }
  }
  if (!eventCode) {
    alert('Unable to generate unique event code. Please try again.');
    return;
  }
  const event = {
    guildName: currentGuild.name,
    metric,
    scope,
    trackedPlayers,
    refreshCooldownMs: REFRESH_COOLDOWN_MS,
    startedAt: Date.now(),
    lastRefreshAt: Date.now(),
    firstRefreshDone: false,
    eventCode,
    isPublic,
    baseline,
    current: baseline
  };

  const saveResult = await updateUserData({
    guildName: currentGuild.name,
    trackedPlayers,
    activeEvent: event
  });
  if (!saveResult.ok) {
    await removeEventCodeIndex(eventCode);
    alert(`Failed to save event: ${saveResult.error}`);
    return;
  }
  const syncResult = await upsertEventCodeIndex(event);
  if (!syncResult.ok) {
    console.error('Failed to sync event index after start:', syncResult.error);
  }
  activeEvent = event;
  renderTrackedPlayersInfo(trackedPlayers);
  renderActiveEvent();
  startCooldownTicker();
}

async function refreshEvent() {
  if (!activeEvent || !currentGuild?.name) return;
  const now = Date.now();
  const cooldownUntil = Number(activeEvent.lastRefreshAt || 0) + Number(activeEvent.refreshCooldownMs || REFRESH_COOLDOWN_MS);
  if (activeEvent.firstRefreshDone && now < cooldownUntil) {
    updateCooldownText();
    return;
  }
  setDashboardEventLoading(true, 'Refreshing event data...');
  await searchGuild(activeEvent.guildName, 'auto', { render: isSearchPage, hydrateWars: false });
  if (activeEvent.metric === 'wars') {
    await hydrateVisibleMemberWars(currentGuild, true, activeEvent.trackedPlayers || []);
  }
  const snapshot = getSnapshot(activeEvent.metric, currentGuild, activeEvent.trackedPlayers || [], activeEvent.scope || 'selected');
  const previousSnapshot = activeEvent.current || null;
  const previousMetricValue = Number(previousSnapshot?.metricValue || 0);
  const nextMetricValue = Number(snapshot?.metricValue || 0);
  const previousPlayers = previousSnapshot?.playerValues || {};
  const nextPlayers = snapshot?.playerValues || {};
  const previousKeys = Object.keys(previousPlayers).sort();
  const nextKeys = Object.keys(nextPlayers).sort();
  const sameKeyCount = previousKeys.length === nextKeys.length;
  const sameKeys = sameKeyCount && previousKeys.every((key, idx) => key === nextKeys[idx]);
  const samePlayerValues = sameKeys && previousKeys.every((key) => Number(previousPlayers[key] || 0) === Number(nextPlayers[key] || 0));
  const snapshotChanged = previousMetricValue !== nextMetricValue || !samePlayerValues;
  activeEvent.current = snapshot;
  activeEvent.lastRefreshAt = Date.now();
  activeEvent.firstRefreshDone = true;
  if (snapshotChanged) {
    const saveResult = await updateUserData({ activeEvent });
    if (!saveResult.ok) {
      console.error('Failed to persist refreshed active event:', saveResult.error);
    }
    if (activeEvent.eventCode) {
      const syncResult = await upsertEventCodeIndex(activeEvent);
      if (!syncResult.ok) {
        console.error('Failed to sync event code on refresh:', syncResult.error);
      }
    }
  }
  renderActiveEvent();
  setDashboardEventLoading(false);
}

async function endEvent() {
  if (!activeEvent) return;
  if (!confirm('End this event and save to history?')) return;

  const totalDelta = getGuildDelta(activeEvent);
  const historyEvent = {
    guildName: activeEvent.guildName,
    type: activeEvent.metric,
    scope: activeEvent.scope,
    trackedPlayers: activeEvent.trackedPlayers,
    startedAt: activeEvent.startedAt,
    endedAt: Date.now(),
    baseline: activeEvent.baseline,
    current: activeEvent.current,
    totalDelta
  };

  const endResult = await updateUserData({ addEvent: historyEvent, activeEvent: null });
  if (!endResult.ok) {
    alert(`Failed to end event: ${endResult.error}`);
    return;
  }
  if (activeEvent.eventCode) {
    await removeEventCodeIndex(activeEvent.eventCode);
  }
  activeEvent = null;
  renderActiveEvent();
  stopCooldownTicker();
  await loadUserDashboard();
}

async function toggleActiveEventVisibility(isPublic) {
  if (!activeEvent?.eventCode) return;
  const result = await updateEventVisibility(activeEvent.eventCode, isPublic);
  if (!result.ok) {
    alert(`Failed to update event visibility: ${result.error || 'unknown error'}`);
    return;
  }
  activeEvent.isPublic = Boolean(isPublic);
  const saveResult = await updateUserData({ activeEvent });
  if (!saveResult.ok) {
    console.error('Failed to persist active event visibility:', saveResult.error);
  }
  renderActiveEvent();
}

function updateScopeUI() {
  const scope = document.getElementById('trackScopeSelect').value;
  document.getElementById('playerSelectSection').classList.toggle('hidden', scope !== 'selected');
}

async function loadEventHistory(prefetchedUserData = null) {
  const list = document.getElementById('eventHistoryList');
  const noEl = document.getElementById('noEventHistory');
  if (!list) return;
  const userData = prefetchedUserData || await loadUserData({ includeEvents: true });
  const events = userData?.events || [];
  if (!events.length) {
    list.innerHTML = '<p class="text-gray-500 text-sm text-center py-4" id="noEventHistory">No events recorded yet.</p>';
    return;
  }
  if (noEl) {
    noEl.classList.add('hidden');
  }
  list.innerHTML = events.map((evt) => `
    <div class="bg-gray-800/50 p-4 rounded-lg">
      <div class="flex justify-between items-center mb-1">
        <span class="text-white font-medium">${escapeHtml(evt.guildName)} (${formatMetric(evt.type || evt.metric)})</span>
        <span class="${Number(evt.totalDelta || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${formatDelta(evt.totalDelta || 0)}</span>
      </div>
      <div class="text-xs text-gray-500">${formatScope(evt.scope || 'selected')} · ${new Date(evt.endedAt || evt.endTime || Date.now()).toLocaleString()}</div>
    </div>
  `).join('');
}

async function loadUserDashboard(prefetchedUserData = null) {
  const userData = prefetchedUserData || await loadUserData({ includeEvents: false });
  if (!userData) return;
  const normalizedEvent = normalizeActiveEvent(userData.activeEvent, userData.trackedPlayers || []);
  activeEvent = normalizedEvent;

  const effectiveGuildName = userData.guildName || normalizedEvent?.guildName || null;

  document.getElementById('trackedGuildDisplay').textContent = effectiveGuildName
    ? `Guild: ${effectiveGuildName}`
    : 'No guild tracked';
  if (!isSearchPage) {
    document.getElementById('userDashboard').classList.remove('hidden');
  }

  if (!effectiveGuildName) {
    document.getElementById('noGuildTracked').classList.remove('hidden');
    document.getElementById('guildTracked').classList.add('hidden');
    renderActiveEvent();
    if (activeEvent) startCooldownTicker();
    updateStopTrackingState();
    return;
  }

  document.getElementById('noGuildTracked').classList.add('hidden');
  document.getElementById('guildTracked').classList.remove('hidden');
  document.getElementById('dashboardGuildName').textContent = effectiveGuildName;
  document.getElementById('dashboardGuildPrefix').textContent = '';
  renderTrackedPlayersInfo(userData.trackedPlayers || []);

  if (activeEvent) {
    renderActiveEvent();
    setDashboardEventLoading(true, 'Loading event data...');
  }
  await searchGuild(effectiveGuildName, 'auto', { render: isSearchPage, hydrateWars: isSearchPage });
  setDashboardEventLoading(false);
  renderActiveEvent();
  if (activeEvent) startCooldownTicker();
  updateStopTrackingState();
}

async function stopTrackingGuild() {
  if (!currentUser) return;
  if (activeEvent) {
    alert('You can only stop tracking when there is no active event.');
    return;
  }
  if (!confirm('Stop tracking this guild and clear selected players?')) return;
  const result = await updateUserData({
    guildName: null,
    trackedPlayers: [],
    activeEvent: null
  });
  if (!result.ok) {
    alert(`Failed to stop tracking: ${result.error}`);
    return;
  }
  currentGuild = null;
  activeEvent = null;
  renderActiveEvent();
  updateTrackedGuildsList(null);
  await loadUserDashboard({
    guildName: null,
    trackedPlayers: [],
    activeEvent: null,
    events: []
  });
}

function updateTrackedGuildsList(name) {
  const list = document.getElementById('trackedGuildsList');
  const noEl = document.getElementById('noTrackedGuilds');
  if (!list || !noEl) return;
  if (!name) {
    noEl.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  noEl.classList.add('hidden');
  list.innerHTML = `
    <button type="button" class="w-full text-left bg-gray-800/50 hover:bg-gray-700/50 p-3 rounded-lg transition-colors" data-guild-name="${escapeHtml(name)}">
      <span class="text-white font-medium">${escapeHtml(name)}</span>
    </button>
  `;
  list.querySelector('button')?.addEventListener('click', () => {
    document.getElementById('guildSearchInput').value = name;
    searchGuild(name, 'name');
  });
}

function configurePageMode() {
  const searchSection = document.getElementById('searchSection');
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  const userDashboard = document.getElementById('userDashboard');
  const trackedGuildsSection = document.getElementById('trackedGuildsSection');
  const eventHistorySection = document.getElementById('eventHistorySection');
  const dashboardOpenSearchBtn = document.getElementById('dashboardOpenSearchBtn');
  const backToDashboardBtn = document.getElementById('backToDashboardBtn');

  if (isSearchPage) {
    searchSection?.classList.remove('hidden');
    userDashboard?.classList.add('hidden');
    trackedGuildsSection?.classList.add('hidden');
    eventHistorySection?.classList.add('hidden');
    backToDashboardBtn?.classList.remove('hidden');
    return;
  }

  searchSection?.classList.add('hidden');
  guildResult?.classList.add('hidden');
  noResult?.classList.add('hidden');
  userDashboard?.classList.remove('hidden');
  trackedGuildsSection?.classList.add('hidden');
  eventHistorySection?.classList.add('hidden');
  backToDashboardBtn?.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', async () => {
  const headerLoginBtn = document.getElementById('headerLoginBtn');
  const headerUserBtn = document.getElementById('headerUserBtn');
  const userMenu = document.getElementById('userMenu');
  const userDisplayName = document.getElementById('userDisplayName');

  configurePageMode();
  currentUser = getCurrentUser();
  if (currentUser) {
    headerLoginBtn.classList.add('hidden');
    headerUserBtn.classList.remove('hidden');
    headerUserBtn.textContent = currentUser;
    userMenu.classList.remove('hidden');
    userDisplayName.textContent = currentUser;
  }

  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('headerUserBtn').addEventListener('click', () => {
    window.location.href = '/guild';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.getElementById('headerLoginBtn').addEventListener('click', () => {
    window.location.href = '/login';
  });

  document.getElementById('guildSearchBtn').addEventListener('click', () => {
    searchGuild(document.getElementById('guildSearchInput').value);
  });
  document.getElementById('guildSearchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchGuild(document.getElementById('guildSearchInput').value);
    }
  });
  document.getElementById('dashboardOpenSearchBtn')?.addEventListener('click', () => {
    window.location.href = '/guild/search';
  });
  document.getElementById('dashboardOpenHistoryBtn')?.addEventListener('click', () => {
    window.location.href = '/guild/event_history';
  });
  document.getElementById('dashboardOpenCodePanelBtn')?.addEventListener('click', () => {
    toggleDashboardCodePanel();
  });
  document.getElementById('dashboardCloseCodePanelBtn')?.addEventListener('click', () => {
    toggleDashboardCodePanel(false);
  });
  document.getElementById('dashboardViewEventCodeBtn')?.addEventListener('click', () => {
    const input = document.getElementById('dashboardEventCodeInput');
    openLeaderboardByCode(input?.value || '');
  });
  document.getElementById('dashboardEventCodeInput')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      openLeaderboardByCode(e.target?.value || '');
    }
  });
  document.getElementById('backToDashboardBtn')?.addEventListener('click', () => {
    window.location.href = '/guild';
  });
  document.getElementById('toggleGuildResultBtn').addEventListener('click', () => {
    guildResultCollapsed = !guildResultCollapsed;
    updateGuildResultCollapseUI();
  });
  document.getElementById('showMemberWarsToggle')?.addEventListener('change', () => {
    if (!currentGuild) return;
    const members = collectGuildMembers(currentGuild);
    renderMembersList(members);
    renderPlayerSelection(members);
  });

  document.getElementById('trackScopeSelect').addEventListener('change', updateScopeUI);
  updateScopeUI();

  document.getElementById('selectAllPlayersBtn').addEventListener('click', () => {
    document.querySelectorAll('#playerCheckboxes input[type="checkbox"]').forEach((el) => {
      el.checked = true;
    });
  });
  document.getElementById('clearPlayersBtn').addEventListener('click', () => {
    document.querySelectorAll('#playerCheckboxes input[type="checkbox"]').forEach((el) => {
      el.checked = false;
    });
  });

  document.getElementById('startEventBtn').addEventListener('click', startEvent);
  document.getElementById('trackGuildBtn').addEventListener('click', () => {
    const section = document.getElementById('playerSelectSection');
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.getElementById('viewGuildBtn').addEventListener('click', () => {
    const result = document.getElementById('guildResult');
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.getElementById('changeGuildBtn').addEventListener('click', () => {
    const section = document.getElementById('playerSelectSection');
    const scope = document.getElementById('trackScopeSelect');
    scope.value = 'selected';
    updateScopeUI();
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.getElementById('stopTrackingBtn')?.addEventListener('click', stopTrackingGuild);
  document.getElementById('refreshEventBtn').addEventListener('click', refreshEvent);
  document.getElementById('dashboardRefreshBtn').addEventListener('click', refreshEvent);
  document.getElementById('endEventBtn').addEventListener('click', endEvent);
  document.getElementById('dashboardEndBtn').addEventListener('click', endEvent);
  document.getElementById('viewLeaderboardBtn').addEventListener('click', openLeaderboardPage);
  document.getElementById('dashboardViewLeaderboardBtn').addEventListener('click', openLeaderboardPage);
  document.getElementById('activeEventPublicToggle')?.addEventListener('change', (e) => {
    toggleActiveEventVisibility(Boolean(e.target.checked));
  });
  document.getElementById('dashboardActiveEventPublicToggle')?.addEventListener('change', (e) => {
    toggleActiveEventVisibility(Boolean(e.target.checked));
  });

  if (currentUser) {
    const userData = await loadUserData({ includeEvents: false });
    await loadUserDashboard(userData);
    updateTrackedGuildsList(userData?.guildName || null);
  }
});
