const USER_API = '/api/user';

function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
}

function formatMetric(metric) {
  return metric === 'wars' ? 'Wars' : 'Guild XP';
}

function formatScope(scope) {
  return scope === 'guild' ? 'Entire Guild' : 'Selected Players';
}

function formatDelta(value) {
  const prefix = value >= 0 ? '+' : '';
  return `${prefix}${Number(value || 0).toLocaleString()}`;
}

function normalizeActiveEvent(rawEvent, fallbackTrackedPlayers = []) {
  if (!rawEvent || typeof rawEvent !== 'object') return null;
  if (rawEvent.metric && rawEvent.startedAt && rawEvent.baseline) return rawEvent;

  const metric = rawEvent.type === 'wars' ? 'wars' : 'xp';
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
  const currentPlayers = event.current?.playerValues || baselinePlayers;
  return Object.keys(baselinePlayers).map((username) => {
    const startValue = Number(baselinePlayers[username] || 0);
    const currentValue = Number(currentPlayers[username] || 0);
    return { username, startValue, currentValue, delta: currentValue - startValue };
  }).sort((a, b) => b.delta - a.delta);
}

async function loadUserData(username) {
  const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(username)}`);
  if (!response.ok) throw new Error(`Failed to load user data: ${response.status}`);
  return response.json();
}

function renderEmpty(message) {
  document.getElementById('leaderboardMeta').textContent = message;
  document.getElementById('leaderboardList').innerHTML = '<p class="text-sm text-gray-500">No active event leaderboard to display.</p>';
}

function renderLeaderboard(event) {
  const metricDelta = Number(event.current?.metricValue || 0) - Number(event.baseline?.metricValue || 0);
  const startedAt = new Date(Number(event.startedAt || Date.now())).toLocaleString();
  document.getElementById('leaderboardMeta').textContent =
    `${event.guildName || 'Unknown Guild'} · ${formatMetric(event.metric)} · ${formatScope(event.scope)} · Delta ${formatDelta(metricDelta)} · Started ${startedAt}`;
  document.getElementById('leaderboardUpdatedAt').textContent = `Updated ${new Date().toLocaleTimeString()}`;

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

  const currentUser = getCurrentUser();
  if (!currentUser) {
    renderEmpty('Please log in to view leaderboard.');
    return;
  }

  try {
    const userData = await loadUserData(currentUser);
    const event = normalizeActiveEvent(userData.activeEvent, userData.trackedPlayers || []);
    if (!event) {
      renderEmpty('No active event found for this user.');
      return;
    }
    renderLeaderboard(event);
  } catch (e) {
    renderEmpty(e.message);
  }
});
