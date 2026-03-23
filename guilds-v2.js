const GUILD_API = '/api/guild';
const USER_API = '/api/user';
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

let currentUser = null;
let currentGuild = null;
let activeEvent = null;
let cooldownTimerId = null;
const memberWarsCache = new Map();

function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
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

async function loadUserData() {
  if (!currentUser) return null;
  try {
    const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(currentUser)}`);
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
      <span class="text-gray-400">${Number(player.contributed).toLocaleString()} XP${showWars ? ` · ${player.wars == null ? '...' : Number(player.wars).toLocaleString()} Wars` : ' · ... Wars'}</span>
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
      <span class="text-gray-500 text-xs ml-auto">${Number(player.contributed).toLocaleString()} XP${showWars ? ` · ${player.wars == null ? '...' : Number(player.wars).toLocaleString()} Wars` : ' · ... Wars'}</span>
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
      <button class="w-full text-left bg-gray-800/50 hover:bg-gray-700/50 border border-gray-700 rounded p-3 transition-colors guild-ambiguous-option" data-prefix="${escapeHtml(option.prefix)}">
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

function getSnapshot(metric, guild, trackedPlayers) {
  const players = collectGuildMembers(guild);
  const playerMap = buildPlayerMap(players);
  const selected = trackedPlayers.length ? trackedPlayers : players.map((p) => p.username);
  const snapshotPlayers = {};
  for (const username of selected) {
    const entry = playerMap[username] || { xp: 0, wars: 0 };
    snapshotPlayers[username] = Number(metric === 'wars' ? entry.wars : entry.xp);
  }
  // #region agent log
  debugLog('pre-fix', 'H4', 'guilds-v2.js:getSnapshot', 'snapshot metric values computed', { metric, selectedCount: selected.length, samplePlayers: Object.entries(snapshotPlayers).slice(0, 3), guildWars: Number(guild?.wars || 0), guildXp: Number(guild?.xpPercent || 0) });
  // #endregion
  return {
    metricValue: metric === 'wars' ? Number(guild.wars || 0) : Number(guild.xpPercent || 0),
    playerValues: snapshotPlayers,
    capturedAt: Date.now()
  };
}

async function fetchMemberWars(uuid) {
  if (!uuid) return null;
  if (memberWarsCache.has(uuid)) return memberWarsCache.get(uuid);
  try {
    const response = await fetch(`https://api.wynncraft.com/v3/player/${encodeURIComponent(uuid)}`);
    // #region agent log
    debugLog('pre-fix', 'H3', 'guilds-v2.js:fetchMemberWars:response', 'player endpoint response status', { uuid, ok: response.ok, status: response.status });
    // #endregion
    if (!response.ok) return null;
    const data = await response.json();
    const wars = Number(data?.globalData?.wars || 0);
    // #region agent log
    debugLog('pre-fix', 'H1', 'guilds-v2.js:fetchMemberWars:parsed', 'parsed wars payload fields', { uuid, wars, hasGlobalData: Boolean(data?.globalData), globalDataKeys: data?.globalData ? Object.keys(data.globalData).slice(0, 8) : [] });
    // #endregion
    memberWarsCache.set(uuid, wars);
    return wars;
  } catch {
    // #region agent log
    debugLog('pre-fix', 'H3', 'guilds-v2.js:fetchMemberWars:catch', 'player endpoint fetch threw', { uuid });
    // #endregion
    return null;
  }
}

async function hydrateVisibleMemberWars(guild) {
  const members = collectGuildMembers(guild);
  const targets = members.filter((member) => member.uuid && !memberWarsCache.has(member.uuid));
  // #region agent log
  debugLog('pre-fix', 'H2', 'guilds-v2.js:hydrateVisibleMemberWars:targets', 'member uuid coverage', { totalMembers: members.length, targets: targets.length, missingUuid: members.filter((m) => !m.uuid).length });
  // #endregion
  if (!targets.length) return;
  const CONCURRENCY = 6;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const chunk = targets.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map((member) => fetchMemberWars(member.uuid)));
  }
}

function openLeaderboardPage() {
  window.location.href = '/guild/leaderboard';
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
  container.innerHTML = players.map((username) => `
    <div class="bg-gray-800/50 rounded p-2 text-sm inline-block mr-2 mb-2">
      <span class="text-white font-medium">${escapeHtml(username)}</span>
    </div>
  `).join('');
}

function renderActiveEvent() {
  const hasEvent = Boolean(activeEvent);
  document.getElementById('activeEventSection').classList.toggle('hidden', !hasEvent);
  document.getElementById('dashboardEventSection').classList.toggle('hidden', !hasEvent);
  document.getElementById('eventSetupSection').classList.toggle('hidden', hasEvent);
  document.getElementById('startEventBtn').classList.toggle('hidden', hasEvent);
  document.getElementById('noActiveEventSection').classList.toggle('hidden', hasEvent);

  if (!hasEvent) return;

  const elapsed = Date.now() - Number(activeEvent.startedAt || Date.now());
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  const durationText = `${hours}h ${minutes}m ${seconds}s`;
  const delta = getGuildDelta(activeEvent);
  const startValue = Number(activeEvent.baseline?.metricValue || 0);
  const currentValue = Number(activeEvent.current?.metricValue || startValue);

  document.getElementById('eventDuration').textContent = durationText;
  document.getElementById('dashboardEventDuration').textContent = durationText;
  document.getElementById('eventMetric').textContent = formatMetric(activeEvent.metric);
  document.getElementById('dashboardEventMetric').textContent = formatMetric(activeEvent.metric);
  document.getElementById('eventScope').textContent = formatScope(activeEvent.scope);
  document.getElementById('dashboardEventScope').textContent = formatScope(activeEvent.scope);
  document.getElementById('eventStartValue').textContent = startValue.toLocaleString();
  document.getElementById('eventCurrentValue').textContent = currentValue.toLocaleString();
  document.getElementById('eventDelta').textContent = formatDelta(delta);
  document.getElementById('dashboardEventDelta').textContent = formatDelta(delta);

  updateCooldownText();
}

async function searchGuild(name, mode = 'auto') {
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  if (!name || !name.trim()) return;

  guildResult.classList.add('hidden');
  noResult.classList.add('hidden');
  hideAmbiguousGuildResults();

  try {
    const response = await fetch(`${GUILD_API}?query=${encodeURIComponent(name)}&mode=${encodeURIComponent(mode)}`);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (response.status === 300 && data?.ambiguous) {
      renderAmbiguousGuildResults(name, data.searchType || mode, data.options || {});
      return;
    }

    if (!response.ok) {
      if (response.status === 404) {
        noResult.classList.remove('hidden');
        currentGuild = null;
        return;
      }
      throw new Error(`API Error: ${response.status}`);
    }
    currentGuild = data;
    displayGuild(currentGuild);
    await hydrateVisibleMemberWars(currentGuild);
    if (currentGuild?.name === data?.name) {
      displayGuild(currentGuild);
    }
  } catch (e) {
    console.error('Search error:', e);
    alert(`Error searching guild: ${e.message}`);
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

  const baseline = getSnapshot(metric, currentGuild, trackedPlayers);
  const event = {
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
  };

  const saveResult = await updateUserData({
    guildName: currentGuild.name,
    trackedPlayers,
    activeEvent: event
  });
  if (!saveResult.ok) {
    alert(`Failed to save event: ${saveResult.error}`);
    return;
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
  await searchGuild(activeEvent.guildName);
  const snapshot = getSnapshot(activeEvent.metric, currentGuild, activeEvent.trackedPlayers || []);
  activeEvent.current = snapshot;
  activeEvent.lastRefreshAt = Date.now();
  activeEvent.firstRefreshDone = true;
  const saveResult = await updateUserData({ activeEvent });
  if (!saveResult.ok) {
    console.error('Failed to persist refreshed active event:', saveResult.error);
  }
  renderActiveEvent();
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
  activeEvent = null;
  renderActiveEvent();
  stopCooldownTicker();
  await loadUserDashboard();
}

function updateScopeUI() {
  const scope = document.getElementById('trackScopeSelect').value;
  document.getElementById('playerSelectSection').classList.toggle('hidden', scope !== 'selected');
}

async function loadEventHistory() {
  const list = document.getElementById('eventHistoryList');
  const noEl = document.getElementById('noEventHistory');
  if (!list) return;
  const userData = await loadUserData();
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

async function loadUserDashboard() {
  const userData = await loadUserData();
  if (!userData) return;
  const normalizedEvent = normalizeActiveEvent(userData.activeEvent, userData.trackedPlayers || []);
  activeEvent = normalizedEvent;

  const effectiveGuildName = userData.guildName || normalizedEvent?.guildName || null;

  document.getElementById('trackedGuildDisplay').textContent = effectiveGuildName
    ? `Guild: ${effectiveGuildName}`
    : 'No guild tracked';
  document.getElementById('userDashboard').classList.remove('hidden');

  if (!effectiveGuildName) {
    document.getElementById('noGuildTracked').classList.remove('hidden');
    document.getElementById('guildTracked').classList.add('hidden');
    renderActiveEvent();
    if (activeEvent) startCooldownTicker();
    return;
  }

  document.getElementById('noGuildTracked').classList.add('hidden');
  document.getElementById('guildTracked').classList.remove('hidden');
  document.getElementById('dashboardGuildName').textContent = effectiveGuildName;
  document.getElementById('dashboardGuildPrefix').textContent = '';
  renderTrackedPlayersInfo(userData.trackedPlayers || []);

  await searchGuild(effectiveGuildName);
  renderActiveEvent();
  if (activeEvent) startCooldownTicker();
  await loadEventHistory();
}

function updateTrackedGuildsList(name) {
  const list = document.getElementById('trackedGuildsList');
  const noEl = document.getElementById('noTrackedGuilds');
  if (!name) {
    noEl.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  noEl.classList.add('hidden');
  list.innerHTML = `
    <button class="w-full text-left bg-gray-800/50 hover:bg-gray-700/50 p-3 rounded-lg transition-colors" data-guild-name="${escapeHtml(name)}">
      <span class="text-white font-medium">${escapeHtml(name)}</span>
    </button>
  `;
  list.querySelector('button')?.addEventListener('click', () => {
    document.getElementById('guildSearchInput').value = name;
    searchGuild(name, 'name');
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  const headerLoginBtn = document.getElementById('headerLoginBtn');
  const headerUserBtn = document.getElementById('headerUserBtn');
  const userMenu = document.getElementById('userMenu');
  const userDisplayName = document.getElementById('userDisplayName');

  currentUser = getCurrentUser();
  if (currentUser) {
    headerLoginBtn.classList.add('hidden');
    headerUserBtn.classList.remove('hidden');
    headerUserBtn.textContent = currentUser;
    userMenu.classList.remove('hidden');
    userDisplayName.textContent = currentUser;
    await loadUserDashboard();
    const userData = await loadUserData();
    updateTrackedGuildsList(userData?.guildName || null);
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
  document.getElementById('refreshEventBtn').addEventListener('click', refreshEvent);
  document.getElementById('dashboardRefreshBtn').addEventListener('click', refreshEvent);
  document.getElementById('endEventBtn').addEventListener('click', endEvent);
  document.getElementById('dashboardEndBtn').addEventListener('click', endEvent);
  document.getElementById('viewLeaderboardBtn').addEventListener('click', openLeaderboardPage);
  document.getElementById('dashboardViewLeaderboardBtn').addEventListener('click', openLeaderboardPage);
});
