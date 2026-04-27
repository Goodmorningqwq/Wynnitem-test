const USER_API = '/api/user';

function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
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
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num.toLocaleString()}`;
}

function showHistoryActions(showLogin = false) {
  const actions = document.getElementById('historyActions');
  const loginCta = document.getElementById('historyLoginCta');
  const trackerCta = document.getElementById('historyTrackerCta');
  if (!actions || !loginCta || !trackerCta) return;
  actions.classList.remove('hidden');
  loginCta.classList.toggle('hidden', !showLogin);
  trackerCta.classList.toggle('hidden', false);
}

async function loadUserData(username) {
  const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(username)}&includeEvents=true`);
  if (!response.ok) {
    throw new Error(`Failed to load user data: ${response.status}`);
  }
  return response.json();
}

function renderEmpty(message) {
  document.getElementById('eventHistoryList').innerHTML = `<p class="text-gray-500 text-sm text-center py-4">${escapeHtml(message)}</p>`;
}

function renderHistory(events) {
  const list = document.getElementById('eventHistoryList');
  if (!Array.isArray(events) || !events.length) {
    renderEmpty('No events recorded yet.');
    showHistoryActions(false);
    return;
  }
  showHistoryActions(false);
  list.innerHTML = events.map((evt) => `
    <div class="bg-gray-800/50 p-4 rounded-lg">
      <div class="flex justify-between items-start mb-2">
        <div>
          <span class="text-white font-medium block">${escapeHtml(evt.guildName || 'Unknown Guild')}</span>
          <span class="text-xs text-gray-400">${formatMetric(evt.type || evt.metric)} · ${formatScope(evt.scope || 'selected')}</span>
        </div>
        <span class="${Number(evt.totalDelta || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${formatDelta(evt.totalDelta || 0)}</span>
      </div>
      <div class="text-xs text-gray-300 mb-1">Ended: ${new Date(evt.endedAt || evt.endTime || Date.now()).toLocaleString()}</div>
      <div class="text-[11px] text-gray-500">Started: ${new Date(evt.startedAt || evt.startTime || Date.now()).toLocaleString()}</div>
      <div class="text-[11px] text-gray-500 mt-1">Tracked players: ${Array.isArray(evt.trackedPlayers) ? evt.trackedPlayers.length : 0}</div>
      <div class="mt-2">
        <a href="/guild/search" class="text-xs text-violet-300 hover:text-violet-200 hover:underline">Open guild search</a>
      </div>
    </div>
  `).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('backToGuildBtn').addEventListener('click', () => {
    window.location.href = '/guild';
  });

  const currentUser = getCurrentUser();
  if (!currentUser) {
    renderEmpty('Please log in to view event history.');
    showHistoryActions(true);
    return;
  }

  try {
    const data = await loadUserData(currentUser);
    renderHistory(data?.events || []);
  } catch (e) {
    renderEmpty(`Unable to load event history: ${e.message}`);
    showHistoryActions(false);
  }
});
