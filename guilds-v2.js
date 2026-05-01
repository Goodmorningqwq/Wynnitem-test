const GUILD_API = '/api/guild';
const GUILD_EVENTS_API = '/api/guild/events';
const USER_API = '/api/user';
const REFRESH_COOLDOWN_MS = 0;
const WYNN_PLAYER_WARS_SPACING_MS = 500;
const WYNN_PLAYER_WARS_REFRESH_SPACING_MS = 280;
const WYNN_PLAYER_WARS_429_BACKOFF_MS = 3200;
const WYNN_PLAYER_WARS_429_WAVE_BATCH_SIZE = 50;
const WYNN_PLAYER_WARS_429_WAVE_WAIT_MS = 5000;

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
const memberRaidsCache = new Map();
const memberRaidsInFlight = new Map();
let memberRaidsHydrateSession = 0;
let guildResultCollapsed = false;
let eventRefreshInFlight = false;
let guildWarsHydrating = false;
let webhookStatusLastEventCode = '';
let webhookStatusRequestInFlight = false;
const isSearchPage = window.location.pathname.startsWith('/guild/search');
let guildSearchMode = 'auto';
const MINI_LB_VIEW_MODE_KEY = 'guild_dashboard_mini_lb_view_mode_v1';
let miniLbViewMode = 'scroll';

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

function getMiniLbViewMode() {
  try {
    const raw = localStorage.getItem(MINI_LB_VIEW_MODE_KEY);
    if (raw === 'minimize' || raw === 'scroll' || raw === 'long') return raw;
  } catch {
    // Ignore localStorage issues.
  }
  return 'scroll';
}

function setMiniLbViewMode(mode) {
  if (!['minimize', 'scroll', 'long'].includes(mode)) return;
  miniLbViewMode = mode;
  try {
    localStorage.setItem(MINI_LB_VIEW_MODE_KEY, mode);
  } catch {
    // Ignore localStorage issues.
  }
}

function updateMiniLbViewButtons() {
  const map = {
    minimize: document.getElementById('dashboardMiniLbViewMinBtn'),
    scroll: document.getElementById('dashboardMiniLbViewScrollBtn'),
    long: document.getElementById('dashboardMiniLbViewLongBtn')
  };
  Object.entries(map).forEach(([mode, button]) => {
    if (!button) return;
    button.classList.toggle('guild-mode-btn--active', miniLbViewMode === mode);
  });
}

function applyMiniLbViewMode() {
  const list = document.getElementById('dashboardEventPlayerBreakdownList');
  if (!list) return;
  list.classList.remove('max-h-40', 'max-h-80', 'max-h-[28rem]', 'overflow-y-auto', 'overflow-y-scroll');
  if (miniLbViewMode === 'minimize') {
    list.classList.add('max-h-40', 'overflow-y-auto');
  } else if (miniLbViewMode === 'long') {
    list.classList.add('max-h-[28rem]', 'overflow-y-auto');
  } else {
    list.classList.add('max-h-80', 'overflow-y-scroll');
  }
  updateMiniLbViewButtons();
}

async function throttlePlayerWarsRequest(spacingMs = WYNN_PLAYER_WARS_SPACING_MS) {
  const now = Date.now();
  const waitMs = Math.max(0, nextPlayerWarsRequestAt - now);
  if (waitMs > 0) {
    warLogVerbose('throttle wait ms', waitMs);
    await delay(waitMs);
  }
  nextPlayerWarsRequestAt = Date.now() + spacingMs;
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

async function wipeUserData() {
  if (!currentUser) return { ok: false, status: 0, error: 'No user logged in' };
  try {
    const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(currentUser)}`, {
      method: 'DELETE'
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
    console.error('Wipe user data error:', e);
    return { ok: false, status: 0, error: e.message };
  }
}

function preSeedMemberWars(guild) {
  if (!guild?.members) return;
  warLog('pre-seeding member wars from guild data');
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  let count = 0;
  for (const rank of ranks) {
    if (!guild.members[rank]) continue;
    for (const [memberKey, member] of Object.entries(guild.members[rank])) {
      const wars = member.globalData?.wars;
      if (typeof wars === 'number') {
        const id = member.uuid || memberKey || '';
        if (id) {
          memberWarsCache.set(id, wars);
          count++;
        }
      }
    }
  }
  warLog(`pre-seeded ${count} members`);
}

function resolveMemberGuildRaids(member) {
  const candidates = [
    member?.globalData?.guildRaids?.total,
    member?.globalData?.raids?.total,
    member?.guildRaids?.total,
    member?.raids?.total
  ];
  let firstFinite = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const raw = candidates[i];
    if (raw === null || raw === undefined || raw === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      if (firstFinite === null) {
        firstFinite = parsed;
      }
      // Prefer first positive value in priority order to avoid stale zero fields,
      // while also avoiding cross-field "max" jumps that can spike event totals.
      if (parsed > 0) {
        return { value: parsed, known: true };
      }
    }
  }
  if (firstFinite !== null) {
    return { value: firstFinite, known: true };
  }
  return { value: 0, known: false };
}

function collectGuildMembers(guild, options = {}) {
  if (!guild?.members) return [];
  const includeHydratedRaidCache = options.includeHydratedRaidCache !== false;
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const players = [];
  for (const rank of ranks) {
    if (!guild.members[rank]) continue;
    for (const [memberKey, member] of Object.entries(guild.members[rank])) {
      const raidState = resolveMemberGuildRaids(member);
      const id = member.uuid || memberKey || null;
      const cachedRaids = includeHydratedRaidCache && id ? memberRaidsCache.get(id) : undefined;
      const hasCachedRaids = Number.isFinite(Number(cachedRaids));
      const guildRaids = raidState.known
        ? (hasCachedRaids ? Math.max(raidState.value, Number(cachedRaids)) : raidState.value)
        : (hasCachedRaids ? Number(cachedRaids) : 0);
      const guildRaidsKnown = raidState.known || hasCachedRaids;
      players.push({
        uuid: id,
        username: member.username || member.legacyName || memberKey,
        contributed: Number(member.contributed || 0),
        guildRaids,
        guildRaidsKnown,
        wars: member.globalData?.wars ?? memberWarsCache.get(member.uuid || memberKey || '') ?? null,
        rank: rank,
        joined: member.joined || '',
        online: member.online || false
      });
    }
  }
  return players;
}

function formatCompactNumber(num) {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'k';
  return num.toString();
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return 'unknown';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  
  const years = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 365));
  const months = Math.floor((diffMs % (1000 * 60 * 60 * 24 * 365)) / (1000 * 60 * 60 * 24 * 30));
  const days = Math.floor((diffMs % (1000 * 60 * 60 * 24 * 30)) / (1000 * 60 * 60 * 24));
  
  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}mo`);
  if (parts.length < 2 && days > 0) parts.push(`${days}d`);
  
  return parts.length > 0 ? parts.join(' ') + ' ago' : 'Today';
}

function getRankConfig(rank) {
  const configs = {
    owner: { color: '#fbbf24', stars: 5, label: 'Owner' },
    chief: { color: '#ff5a68', stars: 4, label: 'Chief' },
    strategist: { color: '#a855f7', stars: 3, label: 'Strategist' },
    captain: { color: '#3b82f6', stars: 2, label: 'Captain' },
    recruiter: { color: '#22c55e', stars: 1, label: 'Recruiter' },
    recruit: { color: '#9ca3af', stars: 0, label: 'Recruit' }
  };
  return configs[rank.toLowerCase()] || configs.recruit;
}

function getMinecraftHeadUrl(player) {
  const id = String(player?.uuid || player?.username || '').trim();
  if (!id) return 'https://mc-heads.net/avatar/Steve/32';
  return `https://mc-heads.net/avatar/${encodeURIComponent(id)}/32`;
}

function buildPlayerMap(players) {
  const map = {};
  for (const player of players) {
    map[player.username] = {
      xp: Number(player.contributed || 0),
      wars: Number(player.wars || 0),
      guildRaids: Number(player.guildRaids || 0),
      guildRaidsKnown: player.guildRaidsKnown !== false
    };
  }
  return map;
}

function findPlayerEntry(playerMap, username) {
  if (!playerMap || !username) return null;
  if (Object.prototype.hasOwnProperty.call(playerMap, username)) {
    return playerMap[username];
  }
  const target = String(username).toLowerCase();
  const keys = Object.keys(playerMap);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (String(key).toLowerCase() === target) {
      return playerMap[key];
    }
  }
  return null;
}

function formatDelta(value) {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${Number(value || 0).toLocaleString()}`;
}

function formatScope(scope) {
  return scope === 'guild' ? 'Entire Guild' : 'Selected Players';
}

function formatMetric(metric) {
  if (metric === 'wars') return 'Wars';
  if (metric === 'guildRaids') return 'Guild Raids';
  return 'Guild XP';
}

function formatRaidsSuffix(guildRaids) {
  const n = Number(guildRaids || 0);
  const label = n === 1 ? 'Graid' : 'Graids';
  return ` · ${n.toLocaleString()} ${label}`;
}

function formatWarsSuffix(wars) {
  if (wars == null) return ' · ... Wars';
  return ` · ${Number(wars).toLocaleString()} Wars`;
}

function showMemberWarsEnabled() {
  const toggle = document.getElementById('showMemberWarsToggle');
  return Boolean(toggle?.checked);
}

function setGuildWarsHydrationProgress(done, total, label = 'Loading wars...') {
  const section = document.getElementById('warsHydrationProgressSection');
  const bar = document.getElementById('warsHydrationProgressBar');
  const text = document.getElementById('warsHydrationProgressText');
  if (!section || !bar || !text) return;
  if (!total || total <= 0) return;
  section.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  bar.style.width = `${pct}%`;
  text.textContent = `${label} (${done}/${total})`;
}

function hideGuildWarsHydrationProgress() {
  const section = document.getElementById('warsHydrationProgressSection');
  section?.classList.add('hidden');
}

function setDashboardWarsHydrationProgress(done, total, label = 'Loading war counts...') {
  const section = document.getElementById('dashboardWarsHydrationProgressSection');
  const bar = document.getElementById('dashboardWarsHydrationProgressBar');
  const text = document.getElementById('dashboardWarsHydrationProgressText');
  if (!section || !bar || !text) return;
  if (!total || total <= 0) return;
  section.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  bar.style.width = `${pct}%`;
  text.textContent = `${label} (${done}/${total})`;
}

function hideDashboardWarsHydrationProgress() {
  const section = document.getElementById('dashboardWarsHydrationProgressSection');
  section?.classList.add('hidden');
}

function setEventWarsHydrationProgress(done, total, label = 'Loading war counts...') {
  const section = document.getElementById('eventWarsHydrationProgressSection');
  const bar = document.getElementById('eventWarsHydrationProgressBar');
  const text = document.getElementById('eventWarsHydrationProgressText');
  if (!section || !bar || !text) return;
  if (!total || total <= 0) return;
  section.classList.remove('hidden');
  const pct = Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  bar.style.width = `${pct}%`;
  text.textContent = `${label} (${done}/${total})`;
}

function hideEventWarsHydrationProgress() {
  const section = document.getElementById('eventWarsHydrationProgressSection');
  section?.classList.add('hidden');
}

function setRefreshWarsHydrationProgress(done, total, label = 'Loading war counts...') {
  setDashboardWarsHydrationProgress(done, total, label);
  setEventWarsHydrationProgress(done, total, label);
}

function hideRefreshWarsHydrationProgress() {
  hideDashboardWarsHydrationProgress();
  hideEventWarsHydrationProgress();
}

function isGuildResultCardVisible() {
  const el = document.getElementById('guildResult');
  return Boolean(el && !el.classList.contains('hidden'));
}

function normalizeActiveEvent(rawEvent, fallbackTrackedPlayers = []) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;

  if (rawEvent.metric && rawEvent.startedAt && rawEvent.baseline) {
    return {
      ...rawEvent,
      refreshCooldownMs:
        rawEvent.refreshCooldownMs !== undefined && rawEvent.refreshCooldownMs !== null
          ? Number(rawEvent.refreshCooldownMs)
          : REFRESH_COOLDOWN_MS
    };
  }

  let metric = 'xp';
  if (rawEvent.type === 'wars') metric = 'wars';
  else if (rawEvent.type === 'guildRaids') metric = 'guildRaids';
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
  hydrateMissingMemberRaids(guild);

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
  if (!players.length) {
    listEl.innerHTML = '<p class="text-gray-500 text-sm">No members</p>';
    return;
  }

  // Update title with count
  const titleEl = document.getElementById('membersTitle');
  if (titleEl) {
    titleEl.textContent = `Guild Members (${players.length})`;
  }

  const tableHeader = `
    <div class="grid grid-cols-[80px_1fr_70px_40px_40px] gap-2 px-3 py-2 border-b border-[rgba(192,132,252,0.24)] text-[10px] uppercase tracking-wider font-bold text-violet-200/60 mb-1">
      <span>Rank</span>
      <span>Member</span>
      <span class="text-right">XP</span>
      <span class="text-right">Wars</span>
      <span class="text-right">Raids</span>
    </div>
  `;

  listEl.innerHTML = tableHeader + players.map((player) => {
    const rc = getRankConfig(player.rank);
    const stars = '★'.repeat(rc.stars).padEnd(5, ' ');
    const onlineIndicator = player.online ? '<span class="w-1.5 h-1.5 rounded-full bg-green-500 inline-block ml-1"></span>' : '';
    const headUrl = getMinecraftHeadUrl(player);
    
    return `
      <div
        onclick="window.viewPlayerProfileFromElement(this)"
        data-profile-username="${escapeHtml(player.username || '')}"
        data-profile-uuid="${escapeHtml(player.uuid || '')}"
        class="grid grid-cols-[80px_1fr_70px_40px_40px] gap-2 px-3 py-1.5 hover:bg-[rgba(236,72,153,0.1)] cursor-pointer rounded transition-all text-[11px] items-center group active:scale-[0.98] border border-transparent hover:border-[rgba(192,132,252,0.24)]">
        <div class="flex flex-col">
          <span style="color: ${rc.color}" class="font-bold uppercase text-[9px] leading-tight">${rc.label}</span>
          <span class="text-[8px] mt-[-2px] opacity-60" style="color: ${rc.color}">${stars}</span>
        </div>
        <div class="flex items-center gap-2 min-w-0">
          <img src="${escapeHtml(headUrl)}" alt="${escapeHtml(player.username)} head" class="w-5 h-5 rounded border border-[rgba(192,132,252,0.35)] bg-black/40 shrink-0">
          <span class="text-white truncate font-medium group-hover:text-pink-200 transition-colors">${escapeHtml(player.username)}</span>
          ${onlineIndicator}
        </div>
        <div class="text-right font-mono text-violet-200/80 group-hover:text-white italic">
          ${formatCompactNumber(player.contributed)}
        </div>
        <div class="text-right font-mono text-pink-200/80 group-hover:text-pink-100">
          ${player.wars ?? 0}
        </div>
        <div class="text-right font-mono text-purple-200/80 group-hover:text-purple-100">
          ${player.guildRaidsKnown ? (player.guildRaids ?? 0) : '...'}
        </div>
      </div>
    `;
  }).join('');
}

function renderPlayerSelection(players) {
  const container = document.getElementById('playerCheckboxes');
  // #region agent log
  debugLog('pre-fix', 'H5', 'guilds-v2.js:renderPlayerSelection', 'rendering player selection wars state', { players: players.length, resolvedWars: players.filter((p) => p.wars != null).length, placeholderWars: players.filter((p) => p.wars == null).length });
  // #endregion
  if (!players.length) {
    container.innerHTML = '<p class="text-violet-200/60 text-sm p-3">No members available</p>';
    return;
  }
  container.innerHTML = players.map((player) => {
    const rc = getRankConfig(player.rank);
    const stars = '★'.repeat(rc.stars).padEnd(5, ' ');
    const headUrl = getMinecraftHeadUrl(player);
    return `
      <label class="flex items-center gap-3 px-3 py-2 hover:bg-[rgba(236,72,153,0.08)] rounded cursor-pointer transition-all border border-transparent has-[:checked]:bg-[rgba(168,85,247,0.16)] has-[:checked]:border-[rgba(232,121,249,0.5)] group select-none">
        <input type="checkbox" value="${escapeHtml(player.username)}" class="hidden peer">
        <div class="flex flex-col min-w-[70px] opacity-80 group-has-[:checked]:opacity-100">
           <span style="color: ${rc.color}" class="text-[9px] font-bold leading-none uppercase">${rc.label}</span>
           <span class="text-[8px] opacity-40" style="color: ${rc.color}">${stars}</span>
        </div>
        <div
          class="flex items-center gap-2 flex-1 min-w-0">
           <img src="${escapeHtml(headUrl)}" alt="${escapeHtml(player.username)} head" class="w-5 h-5 rounded border border-[rgba(192,132,252,0.35)] bg-black/40 shrink-0">
           <span class="text-white text-sm font-medium group-hover:text-pink-200 transition-colors">${escapeHtml(player.username)}</span>
           <svg class="w-3.5 h-3.5 text-green-400 opacity-0 peer-checked:opacity-100 transition-opacity shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>
        </div>
        <div class="ml-auto text-right flex items-center gap-3 opacity-60 group-hover:opacity-100 transition-opacity">
          <span class="text-[10px] font-mono text-violet-200/80">${formatCompactNumber(player.contributed)} XP</span>
          <span class="text-[10px] font-mono text-pink-200/80">${player.wars ?? 0}W</span>
          <span class="text-[10px] font-mono text-purple-200/80">${player.guildRaidsKnown ? (player.guildRaids ?? 0) : '...'}R</span>
        </div>
      </label>
    `;
  }).join('');
}

function getGuildMembersMissingRaids(guild) {
  if (!guild?.members) return [];
  const ranks = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const missing = [];
  for (let i = 0; i < ranks.length; i += 1) {
    const rank = ranks[i];
    if (!guild.members[rank]) continue;
    for (const [memberKey, member] of Object.entries(guild.members[rank])) {
      const id = member.uuid || memberKey || '';
      if (!id) continue;
      const raidState = resolveMemberGuildRaids(member);
      const shouldHydrate = !raidState.known || Number(raidState.value || 0) === 0;
      if (!shouldHydrate || memberRaidsCache.has(id) || memberRaidsInFlight.has(id)) continue;
      missing.push({ uuid: id });
    }
  }
  return missing;
}

async function fetchMemberRaids(uuid) {
  if (!uuid) return null;
  if (memberRaidsCache.has(uuid)) {
    return memberRaidsCache.get(uuid);
  }
  if (memberRaidsInFlight.has(uuid)) {
    return memberRaidsInFlight.get(uuid);
  }
  const task = (async () => {
    try {
      const response = await fetch(`/api/profile?uuid=${encodeURIComponent(uuid)}&_ts=${Date.now()}`, {
        cache: 'no-store'
      });
      if (!response.ok) return null;
      const payload = await response.json().catch(() => null);
      const raids = Number(
        payload?.globalData?.raids?.total
        ?? payload?.globalData?.guildRaids?.total
        ?? payload?.raids?.total
        ?? payload?.guildRaids?.total
      );
      if (!Number.isFinite(raids)) return null;
      memberRaidsCache.set(uuid, raids);
      return raids;
    } catch {
      return null;
    } finally {
      memberRaidsInFlight.delete(uuid);
    }
  })();
  memberRaidsInFlight.set(uuid, task);
  return task;
}

async function hydrateMissingMemberRaids(guild) {
  const pending = getGuildMembersMissingRaids(guild);
  if (!pending.length) return;
  const session = ++memberRaidsHydrateSession;
  let updated = false;
  const maxToHydrate = Math.min(24, pending.length);
  for (let i = 0; i < maxToHydrate; i += 1) {
    if (session !== memberRaidsHydrateSession) return;
    const raids = await fetchMemberRaids(pending[i].uuid);
    if (raids !== null) {
      updated = true;
    }
    if (i < maxToHydrate - 1) {
      await delay(90);
    }
  }
  if (updated && currentGuild && guild && currentGuild.name === guild.name) {
    const members = collectGuildMembers(currentGuild);
    renderMembersList(members);
    renderPlayerSelection(members);
  }
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
        uuid: value.uuid || '',
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
      <button type="button" class="w-full text-left bg-[rgba(18,9,30,0.84)] hover:bg-[rgba(30,16,54,0.92)] border border-[rgba(192,132,252,0.28)] rounded p-3 transition-colors guild-ambiguous-option" data-prefix="${escapeHtml(option.prefix)}" data-name="${escapeHtml(option.name)}" data-uuid="${escapeHtml(option.uuid || '')}">
        <div class="flex items-center justify-between">
          <span class="text-white font-medium">${escapeHtml(option.name)}</span>
          <span class="text-pink-200 text-sm">[${escapeHtml(option.prefix)}]</span>
        </div>
        <p class="text-xs text-violet-200/60 mt-1">${escapeHtml([level, wars].filter(Boolean).join(' · ') || 'Select this guild')}</p>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.guild-ambiguous-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const uuid = btn.getAttribute('data-uuid') || '';
      const exactName = btn.getAttribute('data-name') || '';
      const prefix = btn.getAttribute('data-prefix') || '';
      if (uuid) {
        searchGuild(uuid, 'uuid');
      } else if (exactName) {
        searchGuild(exactName, 'name');
      } else {
        searchGuild(prefix, 'prefix');
      }
    });
  });

  box.classList.remove('hidden');
}

function getSelectedPlayers() {
  const checked = document.querySelectorAll('#playerCheckboxes input[type="checkbox"]:checked');
  return Array.from(checked).map((el) => el.value);
}

function snapshotPlayerValueForMetric(entry, metric) {
  if (metric === 'wars') return Number(entry.wars || 0);
  if (metric === 'guildRaids') return Number(entry.guildRaids || 0);
  return Number(entry.xp || 0);
}

function getLiveRosterUsernames(event, guild) {
  if (!guild || !event) return [];
  if (event.scope === 'guild') {
    return collectGuildMembers(guild).map((m) => m.username);
  }
  return Array.isArray(event.trackedPlayers) ? event.trackedPlayers.slice() : [];
}

function getSnapshot(metric, guild, trackedPlayers, scope = 'selected') {
  // Event snapshots use raw guild API fields only (no hydrated raid cache).
  const players = collectGuildMembers(guild, { includeHydratedRaidCache: false });
  const playerMap = buildPlayerMap(players);
  const selected = trackedPlayers.length ? trackedPlayers : players.map((p) => p.username);
  const snapshotPlayers = {};
  for (const username of selected) {
    const entry = findPlayerEntry(playerMap, username);
    const liveValue = snapshotPlayerValueForMetric(entry || { xp: 0, wars: 0, guildRaids: 0 }, metric);
    snapshotPlayers[username] = liveValue;
  }
  const selectedTotal = Object.values(snapshotPlayers).reduce((sum, value) => sum + Number(value || 0), 0);
  let metricValue;
  if (scope === 'selected') {
    metricValue = selectedTotal;
  } else if (metric === 'wars') {
    metricValue = Number(guild.wars || 0);
  } else if (metric === 'guildRaids') {
    metricValue = selectedTotal;
  } else {
    metricValue = Number(guild.xpPercent || 0);
  }
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

async function fetchMemberWars(uuid, forceRefresh = false, requestSpacingMs = null) {
  const spacingMs = requestSpacingMs ?? WYNN_PLAYER_WARS_SPACING_MS;
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
      await throttlePlayerWarsRequest(spacingMs);
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

function parseRetryAfterMs(retryAfterValue) {
  const raw = retryAfterValue == null ? '' : String(retryAfterValue).trim();
  if (!raw) return WYNN_PLAYER_WARS_429_BACKOFF_MS;
  const num = Number(raw);
  if (Number.isNaN(num) || num <= 0) return WYNN_PLAYER_WARS_429_BACKOFF_MS;
  // Proxy sets Retry-After in seconds (ex: '60'), convert to ms.
  return num * 1000;
}

async function fetchMemberWarsNoThrottle(uuid, forceRefresh = false, on429 = null, maxTries = 3) {
  const uuidShort = typeof uuid === 'string' && uuid.length > 12 ? `${uuid.slice(0, 8)}…` : uuid;
  if (!uuid) {
    warLogVerbose('fetchMemberWarsNoThrottle skipped', 'missing uuid');
    return null;
  }
  if (!forceRefresh && memberWarsCache.has(uuid)) {
    warLogVerbose('fetchMemberWarsNoThrottle cache hit', { uuid: uuidShort });
    return memberWarsCache.get(uuid);
  }

  let attempt = 0;
  while (attempt < maxTries) {
    attempt += 1;
    try {
      const response = await fetch(`/api/player/wars?uuid=${encodeURIComponent(uuid)}`);
      warLogVerbose('fetchMemberWarsNoThrottle response', { uuid: uuidShort, status: response.status, ok: response.ok, attempt });

      if (response.status === 429) {
        if (on429) {
          try {
            on429(response);
          } catch (e) {
            // ignore callback errors
          }
        }
        const retryAfter = parseRetryAfterMs(response.headers.get('Retry-After'));
        await delay(retryAfter);
        continue;
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
        warLog('fetchMemberWarsNoThrottle failed', { uuid: uuidShort, status: response.status, detail: errDetail || '(no body)' });
        return null;
      }

      const data = await response.json();
      const wars = Number(data?.wars || 0);
      memberWarsCache.set(uuid, wars);
      warLogVerbose('fetchMemberWarsNoThrottle ok', { uuid: uuidShort, wars, attempt });
      return wars;
    } catch (err) {
      warLogVerbose('fetchMemberWarsNoThrottle threw', { uuid: uuidShort, message: err?.message || String(err), attempt });
      if (attempt >= maxTries) return null;
      await delay(250 * attempt);
    }
  }

  return null;
}

async function hydrateVisibleMemberWarsWorkerPool(
  guild,
  forceRefresh = false,
  usernames = null,
  sessionId = null,
  concurrency = 6,
  startSpacingMs = 150,
  onProgress = null,
  maxTriesPerMember = 3
) {
  if (!guild) return;
  const members = collectGuildMembers(guild);
  const wantedUsernames = Array.isArray(usernames) ? new Set(usernames) : null;
  const targets = members.filter((member) => {
    if (!member.uuid) return false;
    if (wantedUsernames && !wantedUsernames.has(member.username)) return false;
    if (forceRefresh) return true;
    return !memberWarsCache.has(member.uuid);
  });
  if (!targets.length) return;

  const total = targets.length;
  let done = 0;

  // Atomic request-start scheduler state.
  let nextStartAt = Date.now();
  let pauseUntil = 0;

  let idx = 0;
  let inFlight = 0;
  let aborted = false;
  const inFlightPromises = new Set();

  function shouldAbort() {
    if (sessionId == null) return false;
    return sessionId !== memberWarsHydrateSession;
  }

  function on429(resp) {
    // Pause starting any *new* request for a bit.
    const retryAfter = parseRetryAfterMs(resp.headers.get('Retry-After'));
    pauseUntil = Math.max(pauseUntil, Date.now() + retryAfter);
  }

  function startTask(member) {
    if (shouldAbort()) aborted = true;
    inFlight += 1;
    const p = (async () => {
      try {
        await fetchMemberWarsNoThrottle(member.uuid, forceRefresh, on429, maxTriesPerMember);
      } finally {
        done += 1;
        if (!aborted && onProgress) {
          onProgress({ done, total, user: member.username });
        }
        inFlight -= 1;
        inFlightPromises.delete(p);
      }
    })();
    inFlightPromises.add(p);
  }

  // Scheduler loop: launch up to `concurrency` tasks, but keep request starts
  // spaced by `startSpacingMs` (and delayed by `pauseUntil` when 429 happens).
  while ((idx < targets.length || inFlight > 0) && !aborted) {
    while (inFlight < concurrency && idx < targets.length && !aborted) {
      const now = Date.now();
      const waitPause = Math.max(0, pauseUntil - now);
      const waitStart = Math.max(0, nextStartAt - now);
      const waitMs = Math.max(waitPause, waitStart);
      if (waitMs > 0) {
        await delay(waitMs);
      }
      nextStartAt = Date.now() + startSpacingMs;
      startTask(targets[idx]);
      idx += 1;
    }

    if (inFlight > 0) {
      await Promise.race(Array.from(inFlightPromises));
    }
  }
}

async function hydrateVisibleMemberWarsWaves(
  guild,
  forceRefresh = false,
  usernames = null,
  sessionId = null,
  batchSize = WYNN_PLAYER_WARS_429_WAVE_BATCH_SIZE,
  batchWaitMs = WYNN_PLAYER_WARS_429_WAVE_WAIT_MS,
  onProgress = null,
  maxTriesPerMember = 3
) {
  if (!guild) return;
  const members = collectGuildMembers(guild);
  const wantedUsernames = Array.isArray(usernames) ? new Set(usernames) : null;
  const targets = members.filter((member) => {
    if (!member.uuid) return false;
    if (wantedUsernames && !wantedUsernames.has(member.username)) return false;
    if (forceRefresh) return true;
    return !memberWarsCache.has(member.uuid);
  });
  if (!targets.length) return;

  const total = targets.length;
  let done = 0;
  const shouldAbort = () => sessionId != null && sessionId !== memberWarsHydrateSession;

  for (let i = 0; i < targets.length; i += batchSize) {
    if (shouldAbort()) return;
    const waveTargets = targets.slice(i, i + batchSize);

    await Promise.all(waveTargets.map(async (member) => {
      await fetchMemberWarsNoThrottle(member.uuid, forceRefresh, null, maxTriesPerMember);
      if (shouldAbort()) return;
      done += 1;
      if (onProgress) {
        onProgress({ done, total, user: member.username });
      }
    }));

    if (shouldAbort()) return;
    if (i + batchSize < targets.length) {
      await delay(batchWaitMs);
    }
  }
}

async function hydrateVisibleMemberWars(guild, forceRefresh = false, usernames = null, sessionId = null, progressiveUi = false, requestSpacingMs = null, onProgress = null) {
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
  const limitedTargets = targets;
  const missingUuid = members.filter((m) => !m.uuid).length;
  warLog('hydrateVisibleMemberWars', {
    guildName: guild.name || '(unknown)',
    totalMembers: members.length,
    targets: targets.length,
    processingTargets: limitedTargets.length,
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
  const spacingMs = requestSpacingMs ?? WYNN_PLAYER_WARS_SPACING_MS;
  const total = limitedTargets.length;
  let idx = 0;
  for (const member of limitedTargets) {
    if (sessionId != null && sessionId !== memberWarsHydrateSession) {
      warLog('hydrateVisibleMemberWars aborted', { sessionId, reason: 'superseded by newer search' });
      return;
    }
    idx += 1;
    warLogVerbose(`hydrate fetch ${idx}/${limitedTargets.length}`, { user: member.username });
    await fetchMemberWars(member.uuid, forceRefresh, spacingMs);
    if (sessionId != null && sessionId !== memberWarsHydrateSession) {
      warLog('hydrateVisibleMemberWars aborted', { sessionId, reason: 'superseded during fetch' });
      return;
    }
    if (onProgress) {
      onProgress({ done: idx, total, user: member.username });
    }
  }
  warLog('hydrateVisibleMemberWars done', { fetched: limitedTargets.length });
}

function scheduleMemberWarHydrateAfterSearch(guildRef, renderAtEnd) {
  memberWarsHydrateSession += 1;
  const sid = memberWarsHydrateSession;

  const allMembersForMode = collectGuildMembers(guildRef);
  const fetchableCountForMode = allMembersForMode.filter((m) => m.uuid).length;
  const preciseMode = fetchableCountForMode >= 100;

  void (async () => {
    try {
      if (renderAtEnd) setGuildWarsHydrationProgress(0, 1, 'Loading wars...');

      if (preciseMode) {
        // For large guilds (100+), prioritize precision over speed:
        // sequential fetch with standard 429 retry/backoff, plus a retry loop
        // until `wars == null` users are resolved.
        await hydrateVisibleMemberWars(
          guildRef,
          false,
          null,
          sid,
          false,
          850,
          renderAtEnd ? ({ done, total }) => setGuildWarsHydrationProgress(done, total, 'Loading wars...') : null
        );
        if (sid !== memberWarsHydrateSession) return;
        hideGuildWarsHydrationProgress();

        if (renderAtEnd) {
          let phase2Rounds = 0;
          const maxPhase2Rounds = 3;
          while (phase2Rounds < maxPhase2Rounds) {
            const members = collectGuildMembers(guildRef);
            const missingWarMembers = members.filter((m) => m.wars == null);
            if (!missingWarMembers.length) break;

            const fetchableMissing = missingWarMembers.filter((m) => m.uuid);
            const remainingIdList = missingWarMembers
              .slice(0, 8)
              .map((m) => (m.uuid ? `${m.uuid.slice(0, 8)}…` : m.username))
              .join(', ');
            const remainingSuffix = missingWarMembers.length > 8 ? '...' : '';

            if (!fetchableMissing.length) {
              const baseLabel = `Remaining without UUID (${remainingIdList}${remainingSuffix})`;
              setGuildWarsHydrationProgress(missingWarMembers.length, missingWarMembers.length, baseLabel);
              await delay(2000);
              break;
            }

            const label = `Checking missed players (${remainingIdList}${remainingSuffix})`;
            setGuildWarsHydrationProgress(0, 1, label);
            await hydrateVisibleMemberWars(
              guildRef,
              false,
              null,
              sid,
              false,
              850,
              ({ done, total }) => setGuildWarsHydrationProgress(done, total, label)
            );
            if (sid !== memberWarsHydrateSession) return;
            hideGuildWarsHydrationProgress();
            phase2Rounds += 1;
          }
        }
      } else {
        // Existing fast wave logic for smaller guilds.
        await hydrateVisibleMemberWarsWaves(
          guildRef,
          false,
          null,
          sid,
          WYNN_PLAYER_WARS_429_WAVE_BATCH_SIZE,
          WYNN_PLAYER_WARS_429_WAVE_WAIT_MS,
          renderAtEnd ? ({ done, total }) => setGuildWarsHydrationProgress(done, total, 'Loading wars...') : null,
          3
        );
        if (sid !== memberWarsHydrateSession) return;
        hideGuildWarsHydrationProgress();
        if (renderAtEnd) {
          let phase2Rounds = 0;
          const maxPhase2Rounds = 3;
          while (phase2Rounds < maxPhase2Rounds) {
            const members = collectGuildMembers(guildRef);
            const missingWarMembers = members.filter((m) => m.wars == null);
            if (!missingWarMembers.length) break;

            const fetchableMissing = missingWarMembers.filter((m) => m.uuid);
            const remainingIdList = missingWarMembers
              .slice(0, 8)
              .map((m) => (m.uuid ? `${m.uuid.slice(0, 8)}…` : m.username))
              .join(', ');
            const remainingSuffix = missingWarMembers.length > 8 ? '...' : '';

            if (!fetchableMissing.length) {
              const baseLabel = `Remaining without UUID (${remainingIdList}${remainingSuffix})`;
              setGuildWarsHydrationProgress(missingWarMembers.length, missingWarMembers.length, baseLabel);
              await delay(2500);
              break;
            }

            const label = `Checking missed players (${remainingIdList}${remainingSuffix})`;
            setGuildWarsHydrationProgress(0, fetchableMissing.length, label);
            await hydrateVisibleMemberWarsWaves(
              guildRef,
              true,
              fetchableMissing.map((m) => m.username),
              sid,
              WYNN_PLAYER_WARS_429_WAVE_BATCH_SIZE,
              WYNN_PLAYER_WARS_429_WAVE_WAIT_MS,
              ({ done, total }) => setGuildWarsHydrationProgress(done, total, label),
              10
            );
            if (sid !== memberWarsHydrateSession) return;
            phase2Rounds += 1;
          }
        }
      }

      const finalMissing = collectGuildMembers(guildRef).filter((m) => m.uuid && m.wars == null).length;
      if (finalMissing > 0) {
        await hydrateVisibleMemberWars(
          guildRef,
          false,
          null,
          sid,
          false,
          preciseMode ? 850 : WYNN_PLAYER_WARS_SPACING_MS,
          null
        );
      }
      if (sid !== memberWarsHydrateSession) return;
      if (currentGuild && currentGuild.name === guildRef.name) {
        displayGuild(currentGuild);
      }
    } catch (err) {
      console.error('Background war hydrate error:', err);
      hideGuildWarsHydrationProgress();
    } finally {
      if (renderAtEnd && sid === memberWarsHydrateSession) {
        guildWarsHydrating = false;
      }
    }
  })();
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

async function notifyDiscordLeaderboardUpdate(kind, event, snapshot = null) {
  if (!event?.eventCode || !currentUser) return;
  try {
    const body = {
      eventCode: event.eventCode,
      kind,
      username: currentUser
    };
    if (snapshot && typeof snapshot === 'object') {
      body.snapshot = snapshot;
    }
    const response = await fetch('/api/discord/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      console.error('Discord notify failed:', data?.error || response.status);
    }
  } catch (e) {
    console.error('Discord notify request failed:', e.message);
  }
}

async function loadEventWebhookLinkStatus(options = {}) {
  if (!activeEvent?.eventCode || !currentUser) return;
  const force = Boolean(options.force);
  const eventCode = String(activeEvent.eventCode || '').trim().toUpperCase();
  if (!eventCode) return;
  if (!force && webhookStatusLastEventCode === eventCode) return;
  if (webhookStatusRequestInFlight) return;

  const statusEl = document.getElementById('eventWebhookStatusText');
  const inputEl = document.getElementById('eventWebhookUrlInput');
  webhookStatusRequestInFlight = true;
  if (statusEl && (force || webhookStatusLastEventCode !== eventCode)) {
    statusEl.textContent = 'Checking webhook link...';
  }
  try {
    const response = await fetch(`/api/discord/webhook-link?eventCode=${encodeURIComponent(eventCode)}&username=${encodeURIComponent(currentUser)}&_ts=${Date.now()}`, {
      cache: 'no-store'
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (statusEl) statusEl.textContent = `Webhook status unavailable: ${data?.error || response.status}`;
      webhookStatusLastEventCode = eventCode;
      return;
    }
    const data = await response.json();
    if (data.linked) {
      if (statusEl) {
        const linkedAt = data.linkedAt ? new Date(data.linkedAt).toLocaleString() : 'unknown time';
        statusEl.textContent = `Linked (${data.linkedBy || 'unknown'}) at ${linkedAt}`;
      }
      if (inputEl && !inputEl.value) {
        inputEl.placeholder = 'Webhook linked (URL hidden)';
      }
    } else if (statusEl) {
      statusEl.textContent = 'Not linked';
    }
  } catch {
    if (statusEl) statusEl.textContent = 'Webhook status check failed';
  } finally {
    webhookStatusLastEventCode = eventCode;
    webhookStatusRequestInFlight = false;
  }
}

async function saveEventWebhookLink() {
  if (!activeEvent?.eventCode || !currentUser) {
    alert('Start an event first before linking a webhook.');
    return;
  }
  const inputEl = document.getElementById('eventWebhookUrlInput');
  const statusEl = document.getElementById('eventWebhookStatusText');
  const webhookUrl = String(inputEl?.value || '').trim();
  if (!webhookUrl) {
    alert('Please paste a Discord webhook URL.');
    return;
  }
  if (statusEl) statusEl.textContent = 'Saving webhook link...';
  try {
    const response = await fetch('/api/discord/webhook-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        eventCode: activeEvent.eventCode,
        webhookUrl,
        username: currentUser,
        linkedByDisplay: currentUser
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (statusEl) statusEl.textContent = `Save failed: ${data?.error || response.status}`;
      return;
    }
    if (inputEl) inputEl.value = '';
    if (statusEl) statusEl.textContent = 'Webhook linked successfully.';
    await loadEventWebhookLinkStatus({ force: true });
  } catch {
    if (statusEl) statusEl.textContent = 'Save failed: network error';
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

function openEventHistoryPage() {
  window.location.href = '/guild/event_history';
}

function toggleDashboardCodePanel(forceOpen = null) {
  const panel = document.getElementById('dashboardJoinCodeSection');
  if (!panel) return;
  const shouldFocus = forceOpen === null ? true : Boolean(forceOpen);
  panel.classList.remove('hidden');
  if (shouldFocus) {
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

/** Deep clone so refresh never shares references with current snapshot or mutates start-of-period totals. */
function cloneBaselineForRefresh(baseline) {
  if (!baseline || typeof baseline !== 'object') return baseline;
  try {
    return JSON.parse(JSON.stringify(baseline));
  } catch {
    return baseline;
  }
}

function getGuildDelta(event) {
  if (event?.metric === 'guildRaids') {
    const start = Number(event.baseline?.metricValue || 0);
    const current = Number(event.current?.metricValue || start);
    return current - start;
  }
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
  if (eventRefreshInFlight) {
    refreshBtn.disabled = true;
    dashboardRefreshBtn.disabled = true;
    eventCooldownText.textContent = 'Refreshing...';
    dashboardCooldownText.textContent = 'Refreshing...';
    return;
  }
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
  const maxPreview = 12;
  const visiblePlayers = players.slice(0, maxPreview);
  const remaining = Math.max(0, players.length - visiblePlayers.length);
  container.innerHTML = visiblePlayers.map((username) => `
    <div class="bg-gray-800/50 rounded px-2 py-1 text-sm inline-block mr-2 mb-2">
      <span class="text-white font-medium">${escapeHtml(username)}</span>
    </div>
  `).join('') + (remaining > 0
    ? `<div class="mt-1 text-xs text-violet-300/90 font-medium">+${remaining} more tracked players</div>`
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
  const usernames = Array.from(new Set([
    ...Object.keys(baselinePlayers),
    ...Object.keys(currentPlayers)
  ]));
  const rows = usernames.map((username) => {
    const startValue = Number(baselinePlayers[username] || 0);
    const hasCurrent = Object.prototype.hasOwnProperty.call(currentPlayers, username);
    const currentValue = hasCurrent ? Number(currentPlayers[username] || 0) : startValue;
    const deltaValue = currentValue - startValue;
    return { username, startValue, currentValue, deltaValue };
  }).sort((a, b) => b.deltaValue - a.deltaValue);

  if (!rows.length) {
    section.classList.add('hidden');
    list.innerHTML = '<p class="text-sm text-gray-500">No player data yet.</p>';
    return;
  }

  const metricLabel = event.metric === 'wars' ? 'Wars' : event.metric === 'guildRaids' ? 'Raids' : 'XP';
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
  if (idPrefix === 'dashboard') {
    applyMiniLbViewMode();
  }
}

function renderActiveEvent() {
  const hasEvent = Boolean(activeEvent);
  const quickCodeRow = document.getElementById('dashboardQuickEventCodeRow');
  const quickCodeValue = document.getElementById('dashboardQuickEventCodeValue');
  const searchActiveEventBanner = document.getElementById('searchActiveEventBanner');
  const searchActiveEventBannerText = document.getElementById('searchActiveEventBannerText');
  const hideSearchActiveCard = isSearchPage && hasEvent;
  document.getElementById('activeEventSection').classList.toggle('hidden', !hasEvent || hideSearchActiveCard);
  document.getElementById('dashboardEventSection').classList.toggle('hidden', !hasEvent);
  document.getElementById('eventSetupSection').classList.toggle('hidden', hasEvent);
  document.getElementById('startEventBtn').classList.toggle('hidden', hasEvent);
  document.getElementById('noActiveEventSection').classList.toggle('hidden', hasEvent);
  if (searchActiveEventBanner) {
    searchActiveEventBanner.classList.toggle('hidden', !(isSearchPage && hasEvent));
  }
  if (quickCodeRow) {
    quickCodeRow.classList.toggle('hidden', !hasEvent);
  }

  if (!hasEvent) {
    if (searchActiveEventBannerText) {
      searchActiveEventBannerText.textContent = 'No active event. Start one from this page.';
    }
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
  const startValue = Number(activeEvent.baseline?.metricValue || 0);
  const currentValue = Number(activeEvent.current?.metricValue || startValue);
  const delta = currentValue - startValue;
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
    } else if (activeEvent.metric === 'guildRaids') {
      startLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player Raids (Start)' : 'Total Guild Raids (Start)';
      currentLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player Raids (Now)' : 'Total Guild Raids (Now)';
      if (dashboardStartLabelEl && dashboardCurrentLabelEl) {
        dashboardStartLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player Raids (Start)' : 'Total Guild Raids (Start)';
        dashboardCurrentLabelEl.textContent = activeEvent.scope === 'selected' ? 'Total Player Raids (Now)' : 'Total Guild Raids (Now)';
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
  if (searchActiveEventBannerText) {
    searchActiveEventBannerText.textContent = `${activeEvent.guildName} is currently tracking. Use dashboard to refresh, webhook, and end event.`;
  }
  if (activeEventPublicToggle) {
    activeEventPublicToggle.checked = Boolean(activeEvent.isPublic);
    activeEventPublicToggle.disabled = !activeEvent.eventCode;
  }
  if (dashboardActiveEventPublicToggle) {
    dashboardActiveEventPublicToggle.checked = Boolean(activeEvent.isPublic);
    dashboardActiveEventPublicToggle.disabled = !activeEvent.eventCode;
  }
  renderTrackedPlayersInfo(activeEvent.trackedPlayers || []);
  renderEventPlayerBreakdown(activeEvent);
  renderEventPlayerBreakdown(activeEvent, 'dashboard');
  loadEventWebhookLinkStatus({ force: false }).catch(() => {});

  updateCooldownText();
  updateStopTrackingState();
}

async function searchGuild(name, mode = 'auto', options = {}) {
  const shouldRender = options.render !== false;
  const hydrateWars = options.hydrateWars !== undefined ? options.hydrateWars : false;
  const forceFresh = options.forceFresh !== false;
  warLog('searchGuild', {
    query: (name || '').slice(0, 40),
    mode,
    shouldRender,
    hydrateWars,
    forceFresh,
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
    const url = new URL(GUILD_API, window.location.origin);
    url.searchParams.set('query', name);
    url.searchParams.set('mode', mode);
    if (forceFresh) {
      url.searchParams.set('fresh', '1');
      url.searchParams.set('_ts', String(Date.now()));
    }
    const response = await fetch(url.toString(), {
      cache: forceFresh ? 'no-store' : 'default'
    });
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
    preSeedMemberWars(data);
    if (hydrateWars) {
      guildWarsHydrating = shouldRender;
      if (shouldRender) {
        displayGuild(currentGuild);
      }
      scheduleMemberWarHydrateAfterSearch(data, shouldRender);
    } else if (shouldRender && currentGuild?.name === data?.name) {
      guildWarsHydrating = false;
      displayGuild(currentGuild);
    }
  } catch (e) {
    console.error('Search error:', e);
    if (shouldRender) {
      guildWarsHydrating = false;
    }
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
  const metric = document.getElementById('trackMetricSelect').value;
  if (!currentGuild?.name) {
    alert('Search and load a guild first.');
    return;
  }
  if (metric === 'wars' && guildWarsHydrating) {
    alert('Please wait until wars loading is complete before starting a Wars event.');
    return;
  }
  if (activeEvent) {
    alert('Only one active event is allowed.');
    return;
  }

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
  if (eventRefreshInFlight) return;
  const now = Date.now();
  const cooldownUntil = Number(activeEvent.lastRefreshAt || 0) + Number(activeEvent.refreshCooldownMs || REFRESH_COOLDOWN_MS);
  if (activeEvent.firstRefreshDone && now < cooldownUntil) {
    updateCooldownText();
    return;
  }
  eventRefreshInFlight = true;
  setDashboardEventLoading(true, 'Refreshing event data...');
  updateCooldownText();
  try {
    await searchGuild(activeEvent.guildName, 'auto', { render: isSearchPage, hydrateWars: false });
    const eventScope = activeEvent.scope || 'selected';
    let liveRoster = getLiveRosterUsernames(activeEvent, currentGuild);

    if (activeEvent.metric === 'wars') {
      // Wars data is now instantly available in currentGuild from searchGuild above
      updateRefreshProgress();
    }

      if (isGuildResultCardVisible() && currentGuild) {
        const refreshedMembers = collectGuildMembers(currentGuild);
        renderMembersList(refreshedMembers);
        renderPlayerSelection(refreshedMembers);
        hydrateMissingMemberRaids(currentGuild);
      }

    liveRoster = getLiveRosterUsernames(activeEvent, currentGuild);
    const snapshot = getSnapshot(
      activeEvent.metric,
      currentGuild,
      liveRoster,
      eventScope
    );
    if (eventScope === 'guild') {
      activeEvent.trackedPlayers = liveRoster.slice();
    }

    // Period totals: baseline = raids at event start (immutable). Only current is updated from API.
    const lockedBaseline = cloneBaselineForRefresh(activeEvent.baseline);
    activeEvent.current = snapshot;
    activeEvent.baseline = lockedBaseline;
    activeEvent.lastRefreshAt = Date.now();
    activeEvent.firstRefreshDone = true;
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
    await notifyDiscordLeaderboardUpdate('refresh', activeEvent, snapshot);
  } catch (err) {
    console.error('Refresh event error:', err);
  } finally {
    eventRefreshInFlight = false;
    hideRefreshWarsHydrationProgress();
    setDashboardEventLoading(false);
    renderActiveEvent();
  }
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
  await notifyDiscordLeaderboardUpdate('end', activeEvent, activeEvent.current || activeEvent.baseline || null);

  if (activeEvent.eventCode) {
    await removeEventCodeIndex(activeEvent.eventCode);
  }
  activeEvent = null;
  renderActiveEvent();
  stopCooldownTicker();
  await loadUserDashboard();
  if (confirm('Event saved to history. Open past events now?')) {
    openEventHistoryPage();
  }
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
  await searchGuild(effectiveGuildName, 'auto', { render: isSearchPage });
  setDashboardEventLoading(false);
  renderActiveEvent();
  if (activeEvent) startCooldownTicker();
  updateStopTrackingState();
}

async function stopTrackingGuild() {
  const targetUser = currentUser || getCurrentUser();
  if (!targetUser) {
    alert('You must be logged in to stop tracking.');
    return;
  }
  currentUser = targetUser;
  if (activeEvent) {
    alert('You can only stop tracking when there is no active event.');
    return;
  }
  if (!confirm('Stop tracking this guild?')) return;
  const wipeResult = await wipeUserData();
  if (!wipeResult.ok) {
    alert(`Failed to stop tracking: ${wipeResult.error || 'Failed to wipe user data'}`);
    return;
  }

  // Clear UI selection checkboxes too.
  document.querySelectorAll('#playerCheckboxes input[type="checkbox"]').forEach((el) => {
    el.checked = false;
  });
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
  const dashboardQuickNavSection = document.getElementById('dashboardQuickNavSection');
  const guildHowToSection = document.getElementById('guildHowToSection');
  const trackedGuildsSection = document.getElementById('trackedGuildsSection');
  const eventHistorySection = document.getElementById('eventHistorySection');
  const dashboardOpenSearchBtn = document.getElementById('dashboardOpenSearchBtn');
  const backToDashboardBtn = document.getElementById('backToDashboardBtn');

  guildHowToSection?.classList.toggle('hidden', isSearchPage);

  if (isSearchPage) {
    searchSection?.classList.remove('hidden');
    userDashboard?.classList.add('hidden');
    dashboardQuickNavSection?.classList.add('hidden');
    trackedGuildsSection?.classList.add('hidden');
    eventHistorySection?.classList.add('hidden');
    backToDashboardBtn?.classList.remove('hidden');
    return;
  }

  searchSection?.classList.add('hidden');
  guildResult?.classList.add('hidden');
  noResult?.classList.add('hidden');
  userDashboard?.classList.remove('hidden');
  dashboardQuickNavSection?.classList.remove('hidden');
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
  miniLbViewMode = getMiniLbViewMode();
  applyMiniLbViewMode();
  currentUser = getCurrentUser();
  document.getElementById('guildHowToLoginStep')?.classList.toggle('hidden', Boolean(currentUser));
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

  // Keep guild search in auto-detect mode only.
  guildSearchMode = 'auto';
  const guildSearchInput = document.getElementById('guildSearchInput');
  if (guildSearchInput) {
    guildSearchInput.placeholder = 'Enter guild name, prefix, or UUID...';
  }

  document.getElementById('guildSearchBtn').addEventListener('click', () => {
    searchGuild(document.getElementById('guildSearchInput').value, 'auto');
  });
  document.getElementById('guildSearchInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      searchGuild(document.getElementById('guildSearchInput').value, 'auto');
    }
  });
  document.getElementById('dashboardOpenSearchBtn')?.addEventListener('click', () => {
    window.location.href = '/guild/search';
  });
  document.getElementById('dashboardOpenHistoryBtn')?.addEventListener('click', openEventHistoryPage);
  document.getElementById('dashboardViewPastEventsBtn')?.addEventListener('click', openEventHistoryPage);
  document.getElementById('viewPastEventsBtn')?.addEventListener('click', openEventHistoryPage);
  document.getElementById('searchGoDashboardBtn')?.addEventListener('click', () => {
    window.location.href = '/guild';
  });
  document.getElementById('dashboardMiniLbViewMinBtn')?.addEventListener('click', () => {
    setMiniLbViewMode('minimize');
    applyMiniLbViewMode();
  });
  document.getElementById('dashboardMiniLbViewScrollBtn')?.addEventListener('click', () => {
    setMiniLbViewMode('scroll');
    applyMiniLbViewMode();
  });
  document.getElementById('dashboardMiniLbViewLongBtn')?.addEventListener('click', () => {
    setMiniLbViewMode('long');
    applyMiniLbViewMode();
  });
  document.getElementById('dashboardOpenCodePanelBtn')?.addEventListener('click', () => {
    toggleDashboardCodePanel(true);
  });
  document.getElementById('dashboardCloseCodePanelBtn')?.addEventListener('click', () => {
    const input = document.getElementById('dashboardEventCodeInput');
    if (input) {
      input.value = '';
      input.focus();
    }
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
  document.getElementById('saveEventWebhookBtn')?.addEventListener('click', saveEventWebhookLink);
  document.getElementById('trackGuildBtn').addEventListener('click', () => {
    const section = document.getElementById('playerSelectSection');
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  document.getElementById('viewGuildBtn')?.addEventListener('click', () => {
    const result = document.getElementById('guildResult');
    result.classList.remove('hidden');
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!currentGuild) return;
    guildWarsHydrating = true;
    displayGuild(currentGuild);
    scheduleMemberWarHydrateAfterSearch(currentGuild, true);
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

  // Support quick guild search handoff from homepage.
  if (isSearchPage) {
    const url = new URL(window.location.href);
    const quickQuery = (url.searchParams.get('q') || '').trim();
    if (quickQuery) {
      const input = document.getElementById('guildSearchInput');
      if (input) input.value = quickQuery;
      searchGuild(quickQuery, 'auto', { render: true, hydrateWars: true });
    }
  }

  // Handle modal closing
  document.getElementById('playerProfileModal').addEventListener('click', (e) => {
    if (e.target.id === 'playerProfileModal') window.closePlayerProfile();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.closePlayerProfile();
  });
});

/**
 * View Player Profile Logic
 */
window.viewPlayerProfile = async function(username, uuid = '') {
  const modal = document.getElementById('playerProfileModal');
  const card = document.getElementById('profileCard');
  const content = document.getElementById('profileContent');

  // Show modal + loading
  modal.classList.remove('hidden', 'pointer-events-none');
  modal.classList.add('flex', 'opacity-100');
  card.classList.add('scale-100', 'opacity-100');
  
  content.innerHTML = `
    <div class="flex flex-col items-center justify-center py-20 space-y-6">
      <div class="relative">
        <div class="w-16 h-16 border-4 border-pink-500/20 border-t-pink-500 rounded-full animate-spin"></div>
        <div class="absolute inset-0 flex items-center justify-center">
          <div class="w-8 h-8 bg-pink-500/10 rounded-full animate-pulse"></div>
        </div>
      </div>
      <div class="text-center">
        <p class="text-pink-400 font-mono text-xs uppercase tracking-[0.2em] animate-pulse">Accessing Member Profile</p>
        <p class="text-gray-500 text-[10px] mt-2 font-mono">${escapeHtml(username)}</p>
      </div>
    </div>
  `;

  try {
    const hasUuid = typeof uuid === 'string' && uuid.trim().length > 0;
    const query = hasUuid
      ? `uuid=${encodeURIComponent(uuid.trim())}`
      : `player=${encodeURIComponent(username)}`;
    const res = await fetch(`/api/profile?${query}`);
    if (!res.ok) {
      const respText = await res.text();
      console.error('[wynn-profile] error response:', respText);
      throw new Error(`API Error: ${res.status}`);
    }
    const data = await res.json();
    renderFullPlayerProfile(data);
  } catch (err) {
    content.innerHTML = `
      <div class="text-center py-12 px-6">
        <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-950/30 border border-red-500/50 text-red-500 mb-4 animate-bounce">!</div>
        <p class="text-red-400 font-bold mb-2">Sync Interrupted</p>
        <p class="text-gray-500 text-xs mb-6 max-w-xs mx-auto">Could not retrieve stats for ${escapeHtml(username)}. The Wynncraft API might be under heavy load.</p>
        <button onclick="window.closePlayerProfile()" class="theme-btn px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider">Return to Dashboard</button>
      </div>
    `;
  }
};

window.viewPlayerProfileFromElement = function(element) {
  const username = String(element?.getAttribute('data-profile-username') || '');
  const uuid = String(element?.getAttribute('data-profile-uuid') || '');
  window.viewPlayerProfile(username, uuid);
};

window.closePlayerProfile = function() {
  const modal = document.getElementById('playerProfileModal');
  const card = document.getElementById('profileCard');
  card.classList.remove('scale-100', 'opacity-100');
  modal.classList.remove('opacity-100');
  modal.classList.add('pointer-events-none');
  setTimeout(() => {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }, 300);
};

function renderFullPlayerProfile(data) {
  const content = document.getElementById('profileContent');
  const g = data.globalData || {};
  const ranking = data.ranking || {};

  const formatDateTime = (value) => {
    if (!value) return 'Unknown';
    const dt = new Date(value);
    if (Number.isNaN(dt.getTime())) return 'Unknown';
    return dt.toLocaleString();
  };

  const joinedDate = formatDateTime(data.firstJoin);
  const lastJoinDate = formatDateTime(data.lastJoin);
  const playtime = Math.round(data.playtime || 0);
  const guildName = data.guild?.name || 'No Guild';
  const guildRank = data.guild?.rank || '';
  const grc = getRankConfig(guildRank);
  const onlineLabel = data.online ? `Online (${data.server || 'Unknown'})` : 'Offline';
  const accountRank = data.supportRank || data.rank || 'Player';

  const stats = [
    { label: 'Rank', value: accountRank, color: 'neon-pink' },
    { label: 'Online', value: onlineLabel, color: data.online ? 'text-green-400' : 'text-gray-300' },
    { label: 'Playtime', value: `${playtime.toLocaleString()}h`, color: 'neon-cyan' },
    { label: 'Mobs Killed', value: formatCompactNumber(g.mobsKilled || 0), color: 'text-gray-200' },
    { label: 'Total Level', value: (g.totalLevel || 0).toLocaleString(), color: 'neon-gold' },
    { label: 'Chests Found', value: formatCompactNumber(g.chestsFound || 0), color: 'text-gray-200' },
    { label: 'Wars', value: (g.wars || 0).toLocaleString(), color: 'text-orange-400' },
    { label: 'World Events', value: (g.worldEvents || 0).toLocaleString(), color: 'text-fuchsia-300' },
    { label: 'Lootruns', value: (g.lootruns || 0).toLocaleString(), color: 'text-cyan-300' },
    { label: 'Caves', value: (g.caves || 0).toLocaleString(), color: 'text-violet-300' },
    { label: 'Quests', value: (g.completedQuests || 0).toLocaleString(), color: 'text-yellow-300' },
    { label: 'Guild Raids', value: Number(g.guildRaids?.total || 0).toLocaleString(), color: 'text-indigo-300' }
  ];

  const topRankingCards = Object.entries(ranking)
    .filter(([, value]) => Number.isFinite(Number(value)) && Number(value) > 0)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(0, 8)
    .map(([key, value]) => {
      const label = key
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, (c) => c.toUpperCase())
        .trim();
      return { label, value: Number(value) };
    });

  const raidList = g.raids?.list || {};
  const guildRaidList = g.guildRaids?.list || {};
  const raidDisplay = Object.entries(raidList).map(([name, count]) => `
       <div class="flex flex-col items-center justify-center p-3 profile-stat-card rounded-xl">
        <span class="text-white font-bold text-lg leading-none">${Number(count || 0).toLocaleString()}</span>
        <span class="text-[9px] text-gray-500 uppercase font-bold mt-1 text-center">${escapeHtml(name)}</span>
       </div>
    `).join('');

  const guildRaidDisplay = Object.entries(guildRaidList).map(([name, count]) => `
      <div class="flex flex-col items-center justify-center p-3 profile-stat-card rounded-xl">
        <span class="text-white font-bold text-lg leading-none">${Number(count || 0).toLocaleString()}</span>
        <span class="text-[9px] text-gray-500 uppercase font-bold mt-1 text-center">${escapeHtml(name)}</span>
      </div>
    `).join('');

  const restrictionFlags = data.restrictions || {};
  const restrictedFields = Object.entries(restrictionFlags)
    .filter(([, hidden]) => Boolean(hidden))
    .map(([key]) => key);

  content.innerHTML = `
    <div class="relative">
      <button onclick="window.closePlayerProfile()" class="absolute -top-1 -right-1 p-2 text-gray-500 hover:text-white transition-colors">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
      </button>

      <div class="mb-8 pr-10">
        <h2 class="text-3xl font-black text-white italic tracking-tighter uppercase mb-1">Player Information</h2>
        <p class="text-red-500 font-bold text-xs uppercase tracking-widest mb-3">${escapeHtml(data.username)}</p>
        <div class="flex items-center gap-2">
           <span style="color: ${grc.color}" class="font-bold text-sm uppercase">${grc.label}</span>
           <span class="text-gray-500 text-sm">of</span>
           <span class="text-white font-bold text-sm">${escapeHtml(guildName)}</span>
        </div>
        <p class="text-gray-500 text-xs mt-2">UUID: <span class="text-gray-300">${escapeHtml(data.uuid || 'Unknown')}</span></p>
        <p class="text-gray-500 text-xs">Active Character: <span class="text-gray-300">${escapeHtml(data.activeCharacter || 'Unknown')}</span></p>
      </div>

      <div class="mb-8 pt-6 border-t border-gray-800/50">
        <h3 class="text-gray-400 uppercase text-[10px] tracking-widest font-black mb-4">Global Stats</h3>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
          ${stats.map(s => `
            <div class="profile-stat-card p-3 rounded-xl">
              <span class="text-gray-500 text-[9px] uppercase font-bold block mb-1">${s.label}</span>
              <span class="text-sm font-black ${s.color}">${s.value}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-gray-400 uppercase text-[10px] tracking-widest font-black mb-4">Best Rankings</h3>
        <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
          ${topRankingCards.length ? topRankingCards.map(c => `
            <div class="profile-rank-card p-4 rounded-xl text-center">
              <span class="text-gray-500 text-[8px] uppercase font-bold block mb-1">${c.label}</span>
              <span class="text-xl font-black text-white tracking-tighter">#${c.value.toLocaleString()}</span>
            </div>
          `).join('') : '<p class="text-gray-600 text-[10px] italic">No ranking data available</p>'}
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-gray-400 uppercase text-[10px] tracking-widest font-black mb-4">Raid Completions</h3>
        <div class="grid grid-cols-3 md:grid-cols-4 gap-3">
          ${raidDisplay || '<p class="text-gray-600 text-[10px] italic">No recorded raid completions</p>'}
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-gray-400 uppercase text-[10px] tracking-widest font-black mb-4">Guild Raid Completions</h3>
        <div class="grid grid-cols-3 md:grid-cols-4 gap-3">
          ${guildRaidDisplay || '<p class="text-gray-600 text-[10px] italic">No recorded guild raid completions</p>'}
        </div>
      </div>

      <div class="mb-6 profile-stat-card p-4 rounded-xl">
        <h3 class="text-gray-400 uppercase text-[10px] tracking-widest font-black mb-3">Account Details</h3>
        <p class="text-xs text-gray-300 mb-1">First Join: ${joinedDate}</p>
        <p class="text-xs text-gray-300 mb-1">Last Join: ${lastJoinDate}</p>
        <p class="text-xs text-gray-300 mb-1">Guild Rank Stars: ${escapeHtml(data.guild?.rankStars || 'N/A')}</p>
        <p class="text-xs text-gray-300 mb-1">Veteran: ${data.veteran == null ? 'Unknown' : (data.veteran ? 'Yes' : 'No')}</p>
        <p class="text-xs text-gray-300">Restricted Fields: ${restrictedFields.length ? escapeHtml(restrictedFields.join(', ')) : 'None'}</p>
      </div>

      <div class="mt-8 pt-4 border-t border-gray-800/30 flex justify-between items-center text-[9px] text-gray-600 font-medium">
         <span>Account Created: ${joinedDate}</span>
         <span class="uppercase tracking-widest">Wynncraft Archive v3</span>
      </div>
    </div>
  `;
}
