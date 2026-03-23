const GUILD_API = '/api/guild';
const REDIS_API = '/api/guild/history';

let currentGuild = null;
let activeEvent = null;

function getTrackedGuilds() {
  try {
    return JSON.parse(localStorage.getItem('trackedGuilds')) || [];
  } catch {
    return [];
  }
}

function saveTrackedGuilds(guilds) {
  localStorage.setItem('trackedGuilds', JSON.stringify(guilds));
}

function getActiveEvent() {
  try {
    return JSON.parse(localStorage.getItem('activeEvent')) || null;
  } catch {
    return null;
  }
}

function saveActiveEvent(event) {
  localStorage.setItem('activeEvent', JSON.stringify(event));
}

function clearActiveEvent() {
  localStorage.removeItem('activeEvent');
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

async function searchGuild(name) {
  const guildSearchInput = document.getElementById('guildSearchInput');
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  const loading = document.getElementById('loadingIndicator');

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

    const data = await response.json();
    currentGuild = data;
    displayGuild(data);
  } catch (e) {
    console.error('Search error:', e);
    alert('Error searching guild: ' + e.message);
  }
}

function displayGuild(guild) {
  const guildResult = document.getElementById('guildResult');
  const noResult = document.getElementById('noResult');
  
  document.getElementById('guildName').textContent = guild.name || 'Unknown';
  document.getElementById('guildPrefix').textContent = guild.prefix ? `[${guild.prefix}]` : '[No Prefix]';
  document.getElementById('guildLevel').textContent = guild.level || 0;
  document.getElementById('guildWars').textContent = guild.wars !== null ? guild.wars : 0;
  document.getElementById('guildTerritories').textContent = guild.territories || 0;
  document.getElementById('guildMembers').textContent = guild.members?.total || 0;
  document.getElementById('guildXp').textContent = (guild.xpPercent || 0) + '%';

  const trackedGuilds = getTrackedGuilds();
  const trackBtn = document.getElementById('trackGuildBtn');
  if (trackedGuilds.includes(guild.name)) {
    trackBtn.textContent = '✓ Tracked';
    trackBtn.disabled = true;
  } else {
    trackBtn.textContent = '📌 Track Guild';
    trackBtn.disabled = false;
  }

  guildResult.classList.remove('hidden');
  noResult.classList.add('hidden');

  updateTrackedGuildsList();
}

function trackGuild() {
  if (!currentGuild || !currentGuild.name) return;

  const trackedGuilds = getTrackedGuilds();
  if (!trackedGuilds.includes(currentGuild.name)) {
    trackedGuilds.push(currentGuild.name);
    saveTrackedGuilds(trackedGuilds);
  }

  const trackBtn = document.getElementById('trackGuildBtn');
  trackBtn.textContent = '✓ Tracked';
  trackBtn.disabled = true;

  updateTrackedGuildsList();
}

function updateTrackedGuildsList() {
  const listEl = document.getElementById('trackedGuildsList');
  const noEl = document.getElementById('noTrackedGuilds');
  const trackedGuilds = getTrackedGuilds();

  if (trackedGuilds.length === 0) {
    noEl.classList.remove('hidden');
    return;
  }

  noEl.classList.add('hidden');
  listEl.innerHTML = trackedGuilds.map(name => `
    <button class="w-full text-left bg-gray-800/50 hover:bg-gray-700/50 p-3 rounded-lg transition-colors" data-guild-name="${escapeHtml(name)}">
      <span class="text-white font-medium">${escapeHtml(name)}</span>
    </button>
  `).join('');

  listEl.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('guildSearchInput').value = btn.dataset.guildName;
      searchGuild(btn.dataset.guildName);
    });
  });
}

function startEvent(type) {
  if (!currentGuild || !currentGuild.name) {
    alert('Please search for a guild first');
    return;
  }

  const value = type === 'xp' ? (currentGuild.xpPercent || 0) : (currentGuild.wars || 0);
  
  activeEvent = {
    guildName: currentGuild.name,
    type: type,
    startTime: Date.now(),
    startValue: value,
    updates: []
  };

  saveActiveEvent(activeEvent);
  displayActiveEvent();
}

function refreshEvent() {
  if (!activeEvent || !currentGuild) return;

  const newValue = activeEvent.type === 'xp' 
    ? (currentGuild.xpPercent || 0) 
    : (currentGuild.wars || 0);
  
  const delta = newValue - activeEvent.startValue;

  activeEvent.updates.push({
    time: Date.now(),
    value: newValue,
    delta: delta
  });

  saveActiveEvent(activeEvent);
  displayActiveEvent();
}

function endEvent() {
  if (!activeEvent || !currentGuild) return;

  const endValue = activeEvent.type === 'xp'
    ? (currentGuild.xpPercent || 0)
    : (currentGuild.wars || 0);

  const totalDelta = endValue - activeEvent.startValue;

  const eventRecord = {
    guildName: activeEvent.guildName,
    type: activeEvent.type,
    startTime: activeEvent.startTime,
    startValue: activeEvent.startValue,
    updates: activeEvent.updates,
    endTime: Date.now(),
    endValue: endValue,
    totalDelta: totalDelta
  };

  clearActiveEvent();
  activeEvent = null;

  saveEventToHistory(eventRecord);
  displayActiveEvent();
  loadEventHistory();
}

async function saveEventToHistory(eventRecord) {
  try {
    const response = await fetch(REDIS_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eventRecord)
    });

    if (!response.ok) {
      throw new Error('Failed to save event');
    }
  } catch (e) {
    console.error('Error saving event:', e);
  }
}

async function loadEventHistory() {
  const listEl = document.getElementById('eventHistoryList');
  const noEl = document.getElementById('noEventHistory');

  try {
    const response = await fetch(REDIS_API);
    
    if (!response.ok) {
      throw new Error('Failed to load history');
    }

    const events = await response.json();

    if (!events || events.length === 0) {
      noEl.classList.remove('hidden');
      listEl.innerHTML = '';
      return;
    }

    noEl.classList.add('hidden');
    listEl.innerHTML = events.map(evt => formatEventCard(evt)).join('');
  } catch (e) {
    console.error('Error loading history:', e);
  }
}

function formatEventCard(evt) {
  const startDate = new Date(evt.startTime).toLocaleDateString();
  const endDate = new Date(evt.endTime).toLocaleDateString();
  const typeLabel = evt.type === 'xp' ? 'XP' : 'Wars';
  const deltaClass = evt.totalDelta >= 0 ? 'text-green-400' : 'text-red-400';
  const deltaPrefix = evt.totalDelta >= 0 ? '+' : '';

  return `
    <div class="bg-gray-800/50 p-4 rounded-lg">
      <div class="flex justify-between items-start mb-2">
        <div>
          <span class="text-white font-medium">${escapeHtml(evt.guildName)}</span>
          <span class="text-gray-500 text-sm ml-2">(${typeLabel})</span>
        </div>
        <span class="${deltaClass} font-bold">${deltaPrefix}${evt.totalDelta}</span>
      </div>
      <div class="text-gray-500 text-xs">
        ${startDate} → ${endDate} | ${evt.startValue} → ${evt.endValue}
      </div>
    </div>
  `;
}

function displayActiveEvent() {
  const activeSection = document.getElementById('activeEventSection');
  const noActiveSection = document.getElementById('noActiveEventSection');

  if (!activeEvent) {
    activeSection.classList.add('hidden');
    noActiveSection.classList.remove('hidden');
    return;
  }

  noActiveSection.classList.add('hidden');
  activeSection.classList.remove('hidden');

  const currentValue = activeEvent.updates.length > 0
    ? activeEvent.updates[activeEvent.updates.length - 1].value
    : activeEvent.startValue;

  const delta = currentValue - activeEvent.startValue;
  const deltaClass = delta >= 0 ? 'text-green-400' : 'text-red-400';
  const deltaPrefix = delta >= 0 ? '+' : '';

  const elapsed = Date.now() - activeEvent.startTime;
  const hours = Math.floor(elapsed / 3600000);
  const minutes = Math.floor((elapsed % 3600000) / 60000);

  document.getElementById('eventDuration').textContent = `${hours}h ${minutes}m`;
  document.getElementById('eventStartValue').textContent = activeEvent.startValue;
  document.getElementById('eventCurrentValue').textContent = currentValue;
  document.getElementById('eventDelta').textContent = `${deltaPrefix}${delta}`;

  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  trackXpBtn.disabled = true;
  trackWarsBtn.disabled = true;
  trackXpBtn.classList.add('opacity-50');
  trackWarsBtn.classList.add('opacity-50');
}

function updateEventButtons() {
  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  
  if (activeEvent) {
    trackXpBtn.disabled = true;
    trackWarsBtn.disabled = true;
    trackXpBtn.classList.add('opacity-50');
    trackWarsBtn.classList.add('opacity-50');
  } else {
    trackXpBtn.disabled = false;
    trackWarsBtn.disabled = false;
    trackXpBtn.classList.remove('opacity-50');
    trackWarsBtn.classList.remove('opacity-50');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('guildSearchInput');
  const searchBtn = document.getElementById('guildSearchBtn');
  const trackBtn = document.getElementById('trackGuildBtn');
  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  const refreshBtn = document.getElementById('refreshEventBtn');
  const endBtn = document.getElementById('endEventBtn');

  searchBtn.addEventListener('click', () => searchGuild(searchInput.value));
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchGuild(searchInput.value);
  });

  trackBtn.addEventListener('click', trackGuild);

  trackXpBtn.addEventListener('click', () => startEvent('xp'));
  trackWarsBtn.addEventListener('click', () => startEvent('wars'));

  refreshBtn.addEventListener('click', () => {
    searchGuild(currentGuild.name).then(() => refreshEvent());
  });

  endBtn.addEventListener('click', () => {
    if (confirm('End this event and save to history?')) {
      endEvent();
    }
  });

  activeEvent = getActiveEvent();
  if (activeEvent && activeEvent.guildName) {
    searchGuild(activeEvent.guildName).then(() => {
      displayActiveEvent();
    });
  } else {
    activeEvent = null;
    clearActiveEvent();
  }

  updateTrackedGuildsList();
  loadEventHistory();
  updateEventButtons();
});
