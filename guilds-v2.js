const GUILD_API = '/api/guild';
const USER_API = '/api/user';
const REFRESH_COOLDOWN_MS = 15 * 60 * 1000;

let currentUser = null;
let currentGuild = null;
let activeEvent = null;
let cooldownTimerId = null;

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
    return response.ok;
  } catch (e) {
    console.error('Update user data error:', e);
    return false;
  }
}

function collectGuildMembers(guild) {
  if (!guild?.members) return [];
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const players = [];
  for (const rank of ranks) {
    if (!guild.members[rank]) continue;
    for (const [, member] of Object.entries(guild.members[rank])) {
      players.push({
        username: member.username,
        contributed: Number(member.contributed || 0)
      });
    }
  }
  return players;
}

function buildPlayerMap(players) {
  const map = {};
  for (const player of players) {
    map[player.username] = Number(player.contributed || 0);
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
  if (!players.length) {
    listEl.innerHTML = '<p class="text-gray-500 text-sm">No members</p>';
    return;
  }
  listEl.innerHTML = players.map((player) => `
    <div class="flex justify-between items-center bg-gray-800/30 px-3 py-2 rounded text-sm">
      <span class="text-white font-medium">${escapeHtml(player.username)}</span>
      <span class="text-gray-400">${Number(player.contributed).toLocaleString()} XP</span>
    </div>
  `).join('');
}

function renderPlayerSelection(players) {
  const container = document.getElementById('playerCheckboxes');
  if (!players.length) {
    container.innerHTML = '<p class="text-gray-500 text-sm">No members available</p>';
    return;
  }
  container.innerHTML = players.map((player) => `
    <label class="flex items-center gap-2 p-2 hover:bg-gray-800/50 rounded cursor-pointer">
      <input type="checkbox" value="${escapeHtml(player.username)}" class="accent-purple-500">
      <span class="text-white text-sm">${escapeHtml(player.username)}</span>
      <span class="text-gray-500 text-xs ml-auto">${Number(player.contributed).toLocaleString()} XP</span>
    </label>
  `).join('');
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
    snapshotPlayers[username] = Number(playerMap[username] || 0);
  }
  return {
    metricValue: metric === 'wars' ? Number(guild.wars || 0) : Number(guild.xpPercent || 0),
    playerValues: snapshotPlayers,
    capturedAt: Date.now()
  };
}

function computeLeaderboard(event) {
  const baselinePlayers = event.baseline?.playerValues || {};
  const currentPlayers = event.current?.playerValues || baselinePlayers;
  const entries = Object.keys(baselinePlayers).map((username) => {
    const startValue = Number(baselinePlayers[username] || 0);
    const currentValue = Number(currentPlayers[username] || 0);
    return {
      username,
      startValue,
      currentValue,
      delta: currentValue - startValue
    };
  });
  entries.sort((a, b) => b.delta - a.delta);
  return entries;
}

function renderLeaderboard(event) {
  const section = document.getElementById('leaderboardSection');
  const list = document.getElementById('leaderboardList');
  const summary = document.getElementById('leaderboardSummary');
  const entries = computeLeaderboard(event);
  const total = entries.reduce((sum, item) => sum + item.delta, 0);

  summary.textContent = `${formatMetric(event.metric)} · ${formatScope(event.scope)} · Total ${formatDelta(total)}`;
  if (!entries.length) {
    list.innerHTML = '<p class="text-sm text-gray-500">No leaderboard entries yet.</p>';
  } else {
    list.innerHTML = entries.map((entry, idx) => `
      <div class="bg-gray-900/50 rounded p-3 text-sm">
        <div class="flex justify-between items-center mb-1">
          <span class="text-white font-medium">#${idx + 1} ${escapeHtml(entry.username)}</span>
          <span class="${entry.delta >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${formatDelta(entry.delta)}</span>
        </div>
        <div class="text-xs text-gray-400">${entry.startValue.toLocaleString()} -> ${entry.currentValue.toLocaleString()}</div>
      </div>
    `).join('');
  }
  section.classList.remove('hidden');
}

function hideLeaderboard() {
  document.getElementById('leaderboardSection').classList.add('hidden');
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
  const lastRefreshAt = Number(activeEvent.lastRefreshAt || activeEvent.startedAt || 0);
  const remaining = Math.max(0, (lastRefreshAt + Number(activeEvent.refreshCooldownMs || REFRESH_COOLDOWN_MS)) - Date.now());

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
  const durationText = `${hours}h ${minutes}m`;
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

async function searchGuild(name) {
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  if (!name || !name.trim()) return;

  guildResult.classList.add('hidden');
  noResult.classList.add('hidden');

  try {
    const response = await fetch(`${GUILD_API}?name=${encodeURIComponent(name)}`);
    if (!response.ok) {
      if (response.status === 404) {
        noResult.classList.remove('hidden');
        currentGuild = null;
        return;
      }
      throw new Error(`API Error: ${response.status}`);
    }
    currentGuild = await response.json();
    displayGuild(currentGuild);
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
    baseline,
    current: baseline
  };

  const saved = await updateUserData({
    guildName: currentGuild.name,
    trackedPlayers,
    activeEvent: event
  });
  if (!saved) {
    alert('Failed to save event.');
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
  if (now < cooldownUntil) {
    updateCooldownText();
    return;
  }
  await searchGuild(activeEvent.guildName);
  const snapshot = getSnapshot(activeEvent.metric, currentGuild, activeEvent.trackedPlayers || []);
  activeEvent.current = snapshot;
  activeEvent.lastRefreshAt = Date.now();
  await updateUserData({ activeEvent });
  renderActiveEvent();
}

async function endEvent() {
  if (!activeEvent) return;
  if (!confirm('End this event and save to history?')) return;

  const leaderboard = computeLeaderboard(activeEvent);
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
    totalDelta,
    leaderboard
  };

  await updateUserData({ addEvent: historyEvent, activeEvent: null });
  activeEvent = null;
  hideLeaderboard();
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
  const userData = await loadUserData();
  const events = userData?.events || [];
  if (!events.length) {
    noEl.classList.remove('hidden');
    list.innerHTML = '';
    return;
  }
  noEl.classList.add('hidden');
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

  document.getElementById('trackedGuildDisplay').textContent = userData.guildName
    ? `Guild: ${userData.guildName}`
    : 'No guild tracked';
  document.getElementById('userDashboard').classList.remove('hidden');

  if (!userData.guildName) {
    document.getElementById('noGuildTracked').classList.remove('hidden');
    document.getElementById('guildTracked').classList.add('hidden');
    return;
  }

  document.getElementById('noGuildTracked').classList.add('hidden');
  document.getElementById('guildTracked').classList.remove('hidden');
  document.getElementById('dashboardGuildName').textContent = userData.guildName;
  document.getElementById('dashboardGuildPrefix').textContent = '';
  renderTrackedPlayersInfo(userData.trackedPlayers || []);

  await searchGuild(userData.guildName);

  activeEvent = userData.activeEvent || null;
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
    searchGuild(name);
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
  document.getElementById('refreshEventBtn').addEventListener('click', refreshEvent);
  document.getElementById('dashboardRefreshBtn').addEventListener('click', refreshEvent);
  document.getElementById('endEventBtn').addEventListener('click', endEvent);
  document.getElementById('dashboardEndBtn').addEventListener('click', endEvent);

  const openLeaderboard = () => {
    if (!activeEvent) return;
    renderLeaderboard(activeEvent);
  };
  document.getElementById('viewLeaderboardBtn').addEventListener('click', openLeaderboard);
  document.getElementById('dashboardViewLeaderboardBtn').addEventListener('click', openLeaderboard);
  document.getElementById('closeLeaderboardBtn').addEventListener('click', hideLeaderboard);
});
