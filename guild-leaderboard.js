const USER_API = '/api/user';
const GUILD_EVENTS_API = '/api/guild/events';

function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
}

function formatMetric(metric) {
  if (metric === 'wars') return 'Wars';
  if (metric === 'guildRaids') return 'Guild Raids';
  return 'Guild XP';
}

function formatScope(scope) {
  return scope === 'guild' ? 'Entire Guild' : 'Selected Players';
}

function formatDelta(value) {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${Number(value || 0).toLocaleString()}`;
}

function setCodeValidation(message, tone = 'neutral') {
  const el = document.getElementById('eventCodeValidation');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('text-gray-500', 'text-red-300', 'text-green-300', 'text-violet-300');
  if (tone === 'error') {
    el.classList.add('text-red-300');
    return;
  }
  if (tone === 'success') {
    el.classList.add('text-green-300');
    return;
  }
  if (tone === 'guide') {
    el.classList.add('text-violet-300');
    return;
  }
  el.classList.add('text-gray-500');
}

function updateSummary(event = null) {
  const guildEl = document.getElementById('summaryGuild');
  const metricEl = document.getElementById('summaryMetric');
  const scopeEl = document.getElementById('summaryScope');
  const deltaEl = document.getElementById('summaryDelta');
  const startedEl = document.getElementById('summaryStarted');
  if (!guildEl || !metricEl || !scopeEl || !deltaEl || !startedEl) return;

  if (!event) {
    guildEl.textContent = '-';
    metricEl.textContent = '-';
    scopeEl.textContent = '-';
    deltaEl.textContent = '-';
    deltaEl.className = 'text-white font-semibold';
    startedEl.textContent = '-';
    return;
  }

  const metricDelta = Number(event.current?.metricValue || 0) - Number(event.baseline?.metricValue || 0);
  guildEl.textContent = event.guildName || 'Unknown Guild';
  metricEl.textContent = formatMetric(event.metric);
  scopeEl.textContent = formatScope(event.scope);
  deltaEl.textContent = formatDelta(metricDelta);
  deltaEl.className = `${metricDelta >= 0 ? 'text-green-300' : 'text-red-300'} font-semibold`;
  startedEl.textContent = new Date(Number(event.startedAt || Date.now())).toLocaleString();
}

function normalizeActiveEvent(rawEvent, fallbackTrackedPlayers = []) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  if (rawEvent.metric && rawEvent.startedAt && rawEvent.baseline) return rawEvent;

  let metric = 'xp';
  if (rawEvent.type === 'wars') metric = 'wars';
  else if (rawEvent.type === 'guildRaids') metric = 'guildRaids';
  const startedAt = Number(rawEvent.startTime || Date.now());
  const startValue = Number(rawEvent.startValue || 0);
  const updates = Array.isArray(rawEvent.updates) ? rawEvent.updates : [];
  const latestUpdate = updates.length ? updates[updates.length - 1] : null;
  const currentValue = Number(latestUpdate?.value ?? startValue);

  return {
    guildName: rawEvent.guildName || null,
    metric,
    scope: rawEvent.scope || 'selected',
    trackedPlayers: Array.isArray(rawEvent.trackedPlayers) ? rawEvent.trackedPlayers : fallbackTrackedPlayers,
    startedAt,
    baseline: rawEvent.baseline || { metricValue: startValue, playerValues: {} },
    current: rawEvent.current || { metricValue: currentValue, playerValues: {} }
  };
}

function computeLeaderboard(event) {
  const baselinePlayers = event.baseline?.playerValues || {};
  const currentPlayers = event.current?.playerValues || {};
  const names = Array.from(new Set([
    ...Object.keys(baselinePlayers),
    ...Object.keys(currentPlayers)
  ]));
  return names.map((username) => {
    const startValue = Number(baselinePlayers[username] || 0);
    const currentValue = Number(
      Object.prototype.hasOwnProperty.call(currentPlayers, username)
        ? currentPlayers[username]
        : startValue
    );
    return { username, startValue, currentValue, delta: currentValue - startValue };
  }).sort((a, b) => b.delta - a.delta);
}

async function loadUserData(username) {
  const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(username)}&includeEvents=false`);
  if (!response.ok) throw new Error(`Failed to load user data: ${response.status}`);
  return response.json();
}

async function loadEventByCode(code, username) {
  const query = new URLSearchParams({ code: code.toUpperCase() });
  if (username) query.set('username', username);
  const response = await fetch(`${GUILD_EVENTS_API}?${query.toString()}`);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || `Failed to load event: ${response.status}`);
  }
  return response.json();
}

function renderEmpty(message) {
  document.getElementById('leaderboardMeta').textContent = message;
  document.getElementById('leaderboardList').innerHTML = '<p class="text-sm text-gray-500">No active event leaderboard to display.</p>';
  updateSummary(null);
}

function renderLeaderboard(event) {
  const metricDelta = Number(event.current?.metricValue || 0) - Number(event.baseline?.metricValue || 0);
  const startedAt = new Date(Number(event.startedAt || Date.now())).toLocaleString();
  document.getElementById('leaderboardMeta').textContent =
    `Showing ${event.guildName || 'Unknown Guild'} · ${formatMetric(event.metric)} · ${formatScope(event.scope)} · Started ${startedAt}`;
  document.getElementById('leaderboardUpdatedAt').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  updateSummary(event);

  const entries = computeLeaderboard(event);
  if (!entries.length) {
    document.getElementById('leaderboardList').innerHTML = '<p class="text-sm text-gray-500">No player snapshots found for this event.</p>';
    return;
  }

  document.getElementById('leaderboardList').innerHTML = entries.map((entry, index) => `
    <div class="bg-gray-800/40 rounded p-3">
      <div class="flex justify-between items-center">
        <span class="text-white font-medium">#${index + 1} ${entry.username}</span>
        <span class="${entry.delta >= 0 ? 'text-green-400' : 'text-red-400'} font-semibold">${formatDelta(entry.delta)}</span>
      </div>
      <p class="text-xs text-gray-400 mt-1">${entry.startValue.toLocaleString()} -> ${entry.currentValue.toLocaleString()}</p>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('backToGuildBtn').addEventListener('click', () => {
    window.location.href = '/guild';
  });

  const codeInput = document.getElementById('eventCodeInput');
  const viewCodeBtn = document.getElementById('viewEventCodeBtn');
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = (params.get('code') || '').trim().toUpperCase();
  if (codeFromUrl) {
    codeInput.value = codeFromUrl;
    setCodeValidation('Loaded event code from URL.', 'guide');
  }
  const submitCode = () => {
    const enteredCode = (codeInput.value || '').trim().toUpperCase();
    if (!enteredCode) {
      setCodeValidation('Enter an event code before viewing leaderboard.', 'error');
      return;
    }
    setCodeValidation('Opening leaderboard by code...', 'guide');
    window.location.href = `/guild/leaderboard?code=${encodeURIComponent(enteredCode)}`;
  };
  viewCodeBtn.addEventListener('click', submitCode);
  codeInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      submitCode();
    }
  });
  document.getElementById('copyEventLinkBtn')?.addEventListener('click', async () => {
    const enteredCode = ((codeInput.value || '').trim() || codeFromUrl || '').toUpperCase();
    if (!enteredCode) {
      setCodeValidation('Enter a code first, then copy the share link.', 'error');
      return;
    }
    const url = `${window.location.origin}/guild/leaderboard?code=${encodeURIComponent(enteredCode)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCodeValidation('Leaderboard link copied to clipboard.', 'success');
    } catch {
      setCodeValidation('Unable to copy link in this browser.', 'error');
    }
  });

  const currentUser = getCurrentUser();
  if (!currentUser && !codeFromUrl) {
    renderEmpty('Please log in to view leaderboard.');
    setCodeValidation('Log in or paste an event code to continue.', 'guide');
    return;
  }

  try {
    let event = null;
    if (codeFromUrl) {
      const eventFromCode = await loadEventByCode(codeFromUrl, currentUser || '');
      event = normalizeActiveEvent(eventFromCode, eventFromCode?.trackedPlayers || []);
    } else {
      const userData = await loadUserData(currentUser);
      event = normalizeActiveEvent(userData.activeEvent, userData.trackedPlayers || []);
    }
    if (!event) {
      renderEmpty('No active event found for this user.');
      setCodeValidation('No active event found. Paste an event code to view shared data.', 'guide');
      return;
    }
    setCodeValidation('Leaderboard loaded.', 'success');
    renderLeaderboard(event);
  } catch (e) {
    renderEmpty(e.message);
    setCodeValidation(e.message, 'error');
  }
});
