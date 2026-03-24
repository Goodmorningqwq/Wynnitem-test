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
  return metric === 'wars' ? 'Wars' : 'Guild XP';
}

function formatScope(scope) {
  return scope === 'guild' ? 'Entire Guild' : 'Selected Players';
}

function formatDelta(value) {
  const num = Number(value || 0);
  return `${num >= 0 ? '+' : ''}${num.toLocaleString()}`;
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
    return;
  }
  list.innerHTML = events.map((evt) => `
    <div class="bg-gray-800/50 p-4 rounded-lg">
      <div class="flex justify-between items-center mb-1">
        <span class="text-white font-medium">${escapeHtml(evt.guildName || 'Unknown Guild')} (${formatMetric(evt.type || evt.metric)})</span>
        <span class="${Number(evt.totalDelta || 0) >= 0 ? 'text-green-400' : 'text-red-400'} font-bold">${formatDelta(evt.totalDelta || 0)}</span>
      </div>
      <div class="text-xs text-gray-500">${formatScope(evt.scope || 'selected')} · ${new Date(evt.endedAt || evt.endTime || Date.now()).toLocaleString()}</div>
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
    return;
  }

  try {
    const data = await loadUserData(currentUser);
    renderHistory(data?.events || []);
  } catch (e) {
    renderEmpty(`Unable to load event history: ${e.message}`);
  }
});
