const GUILD_API = '/api/guild';
const USER_API = '/api/user';

let currentUser = null;
let currentGuild = null;
let activeEvent = null;

// User session management
function getCurrentUser() {
  try {
    return localStorage.getItem('currentUser');
  } catch {
    return null;
  }
}

function setCurrentUser(username) {
  localStorage.setItem('currentUser', username);
}

function getUserHash() {
  try {
    return localStorage.getItem('userHash');
  } catch {
    return null;
  }
}

function setUserHash(hash) {
  localStorage.setItem('userHash', hash);
}

function logout() {
  localStorage.removeItem('currentUser');
  localStorage.removeItem('userHash');
  currentUser = null;
  window.location.href = '/guild';
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

async function updateUserData(data) {
  if (!currentUser) return false;
  
  try {
    const response = await fetch(`${USER_API}/data?username=${encodeURIComponent(currentUser)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    return response.ok;
  } catch (e) {
    console.error('Update user data error:', e);
    return false;
  }
}

async function registerUser(username, password) {
  try {
    const response = await fetch(`${USER_API}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Registration failed');
    }
    return result;
  } catch (e) {
    console.error('Register error:', e);
    throw e;
  }
}

async function loginUser(username, password) {
  try {
    const response = await fetch(`${USER_API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'Login failed');
    }
    return result;
  } catch (e) {
    console.error('Login error:', e);
    throw e;
  }
}

// Legacy functions (kept for compatibility)
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
  if (activeEvent) {
    saveActiveEventToRedis(null);
  }
  activeEvent = null;
  localStorage.removeItem('activeEvent');
}

async function saveActiveEventToRedis(event) {
  if (!currentUser) return;
  await updateUserData({ activeEvent: event });
}

async function saveEventToRedis(eventRecord) {
  if (!currentUser) return;
  await updateUserData({ addEvent: eventRecord });
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

  // Display members list
  displayMembersList(guild.members);
  populateMemberSelect(guild.members);

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

function displayMembersList(members) {
  const listEl = document.getElementById('guildMembersList');
  
  if (!members || members.total === 0) {
    listEl.innerHTML = '<p class="text-gray-500 text-sm">No members</p>';
    return;
  }

  const rankOrder = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  const rankLabels = {
    owner: 'Owner',
    chief: 'Chief',
    strategist: 'Strategist',
    captain: 'Captain',
    recruiter: 'Recruiter',
    recruit: 'Recruit'
  };

  let memberHtml = '';
  
  for (const rank of rankOrder) {
    if (!members[rank]) continue;
    
    const rankMembers = Object.entries(members[rank]);
    for (const [uuid, data] of rankMembers) {
      const rankLabel = rankLabels[rank] || rank;
      const onlineStatus = data.online ? 'text-green-400' : 'text-gray-500';
      const contribution = data.contributed ? data.contributed.toLocaleString() : '0';
      
      memberHtml += `
        <div class="flex justify-between items-center bg-gray-800/30 px-3 py-2 rounded text-sm">
          <div class="flex items-center gap-2">
            <span class="text-white font-medium">${escapeHtml(data.username)}</span>
            <span class="text-xs ${onlineStatus}">●</span>
          </div>
          <div class="text-right">
            <span class="text-xs text-violet-400 mr-2">${rankLabel}</span>
            <span class="text-gray-400 text-xs">${contribution} XP</span>
          </div>
        </div>
      `;
    }
  }

  listEl.innerHTML = memberHtml;
}

function populateMemberSelect(members) {
  const selectEl = document.getElementById('memberSelect');
  const rankOrder = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  
  let options = '<option value="">-- Select a member --</option>';
  
  for (const rank of rankOrder) {
    if (!members[rank]) continue;
    
    const rankMembers = Object.entries(members[rank]);
    for (const [uuid, data] of rankMembers) {
      const contribution = data.contributed ? data.contributed.toLocaleString() : '0';
      options += `<option value="${escapeHtml(data.username)}" data-contributed="${data.contributed || 0}">${escapeHtml(data.username)} (${contribution} XP)</option>`;
    }
  }
  
  selectEl.innerHTML = options;
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

function startEvent(type, memberUsername = null) {
  if (!currentGuild || !currentGuild.name) {
    alert('Please search for a guild first');
    return;
  }

  let value;
  if (type === 'member') {
    // Find member's current contribution
    const member = findMemberByUsername(memberUsername);
    value = member ? (member.contributed || 0) : 0;
    if (!member) {
      alert('Member not found');
      return;
    }
  } else if (type === 'xp') {
    value = currentGuild.xpPercent || 0;
  } else {
    value = currentGuild.wars || 0;
  }
  
  activeEvent = {
    guildName: currentGuild.name,
    type: type,
    memberUsername: memberUsername,
    startTime: Date.now(),
    startValue: value,
    updates: []
  };

  saveActiveEvent(activeEvent);
  saveActiveEventToRedis(activeEvent);
  displayActiveEvent();
}

function findMemberByUsername(username) {
  if (!currentGuild || !currentGuild.members) return null;
  
  const rankOrder = ['owner', 'chief', 'strategist', 'captain', 'recruiter', 'recruit'];
  
  for (const rank of rankOrder) {
    if (!currentGuild.members[rank]) continue;
    
    for (const [uuid, data] of Object.entries(currentGuild.members[rank])) {
      if (data.username === username) {
        return data;
      }
    }
  }
  return null;
}

function refreshEvent() {
  if (!activeEvent || !currentGuild) return;

  let newValue;
  if (activeEvent.type === 'member') {
    const member = findMemberByUsername(activeEvent.memberUsername);
    newValue = member ? (member.contributed || 0) : 0;
  } else if (activeEvent.type === 'xp') {
    newValue = currentGuild.xpPercent || 0;
  } else {
    newValue = currentGuild.wars || 0;
  }
  
  const delta = newValue - activeEvent.startValue;

  activeEvent.updates.push({
    time: Date.now(),
    value: newValue,
    delta: delta
  });

  saveActiveEvent(activeEvent);
  saveActiveEventToRedis(activeEvent);
  displayActiveEvent();
}

function endEvent() {
  if (!activeEvent || !currentGuild) return;

  let endValue;
  if (activeEvent.type === 'member') {
    const member = findMemberByUsername(activeEvent.memberUsername);
    endValue = member ? (member.contributed || 0) : 0;
  } else if (activeEvent.type === 'xp') {
    endValue = currentGuild.xpPercent || 0;
  } else {
    endValue = currentGuild.wars || 0;
  }

  const totalDelta = endValue - activeEvent.startValue;

  const eventRecord = {
    guildName: activeEvent.guildName,
    type: activeEvent.type,
    memberUsername: activeEvent.memberUsername,
    userHash: getUserHash(),
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
  updateEventButtons();
}

async function saveEventToHistory(eventRecord) {
  if (currentUser) {
    await updateUserData({ addEvent: eventRecord });
  }
}

async function loadEventHistory() {
  const listEl = document.getElementById('eventHistoryList');
  const noEl = document.getElementById('noEventHistory');

  if (!currentUser) {
    noEl.classList.remove('hidden');
    listEl.innerHTML = '';
    return;
  }

  try {
    const userData = await loadUserData();
    const events = userData?.events || [];

    if (events.length === 0) {
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
  
  let typeLabel;
  if (evt.type === 'xp') {
    typeLabel = 'Guild XP';
  } else if (evt.type === 'wars') {
    typeLabel = 'Wars';
  } else if (evt.type === 'member') {
    typeLabel = `Member: ${escapeHtml(evt.memberUsername)}`;
  } else {
    typeLabel = evt.type;
  }
  
  const deltaClass = evt.totalDelta >= 0 ? 'text-green-400' : 'text-red-400';
  const deltaPrefix = evt.totalDelta >= 0 ? '+' : '';
  const formatValue = (val) => val ? val.toLocaleString() : '0';

  return `
    <div class="bg-gray-800/50 p-4 rounded-lg">
      <div class="flex justify-between items-start mb-2">
        <div>
          <span class="text-white font-medium">${escapeHtml(evt.guildName)}</span>
          <span class="text-gray-500 text-sm ml-2">(${typeLabel})</span>
        </div>
        <span class="${deltaClass} font-bold">${deltaPrefix}${formatValue(evt.totalDelta)}</span>
      </div>
      <div class="text-gray-500 text-xs">
        ${startDate} → ${endDate} | ${formatValue(evt.startValue)} → ${formatValue(evt.endValue)}
      </div>
    </div>
  `;
}

function displayActiveEvent() {
  const activeSection = document.getElementById('activeEventSection');
  const noActiveSection = document.getElementById('noActiveEventSection');
  const eventInfo = document.getElementById('eventInfo');

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

  // Format values with commas for large numbers
  const formatValue = (val) => val.toLocaleString();

  document.getElementById('eventDuration').textContent = `${hours}h ${minutes}m`;
  document.getElementById('eventStartValue').textContent = formatValue(activeEvent.startValue);
  document.getElementById('eventCurrentValue').textContent = formatValue(currentValue);
  document.getElementById('eventDelta').textContent = `${deltaPrefix}${formatValue(delta)}`;

  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  const trackMemberXpBtn = document.getElementById('trackMemberXpBtn');
  trackXpBtn.disabled = true;
  trackWarsBtn.disabled = true;
  trackMemberXpBtn.disabled = true;
  trackXpBtn.classList.add('opacity-50');
  trackWarsBtn.classList.add('opacity-50');
  trackMemberXpBtn.classList.add('opacity-50');
}

function updateEventButtons() {
  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  const trackMemberXpBtn = document.getElementById('trackMemberXpBtn');
  const memberSelectSection = document.getElementById('memberSelectSection');
  
  if (activeEvent) {
    trackXpBtn.disabled = true;
    trackWarsBtn.disabled = true;
    trackMemberXpBtn.disabled = true;
    trackXpBtn.classList.add('opacity-50');
    trackWarsBtn.classList.add('opacity-50');
    trackMemberXpBtn.classList.add('opacity-50');
    memberSelectSection.classList.add('hidden');
  } else {
    trackXpBtn.disabled = false;
    trackWarsBtn.disabled = false;
    trackMemberXpBtn.disabled = false;
    trackXpBtn.classList.remove('opacity-50');
    trackWarsBtn.classList.remove('opacity-50');
    trackMemberXpBtn.classList.remove('opacity-50');
    memberSelectSection.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('guildSearchInput');
  const searchBtn = document.getElementById('guildSearchBtn');
  const trackBtn = document.getElementById('trackGuildBtn');
  const trackXpBtn = document.getElementById('trackXpBtn');
  const trackWarsBtn = document.getElementById('trackWarsBtn');
  const trackMemberXpBtn = document.getElementById('trackMemberXpBtn');
  const startMemberTrackBtn = document.getElementById('startMemberTrackBtn');
  const refreshBtn = document.getElementById('refreshEventBtn');
  const endBtn = document.getElementById('endEventBtn');

  // Header elements
  const headerLoginBtn = document.getElementById('headerLoginBtn');
  const headerUserBtn = document.getElementById('headerUserBtn');

  // Main UI elements
  const searchSection = document.getElementById('searchSection');
  const userMenu = document.getElementById('userMenu');
  const userDisplayName = document.getElementById('userDisplayName');
  const trackedGuildDisplay = document.getElementById('trackedGuildDisplay');
  const logoutBtn = document.getElementById('logoutBtn');

  // User dashboard elements
  const userDashboard = document.getElementById('userDashboard');
  const noGuildTracked = document.getElementById('noGuildTracked');
  const guildTracked = document.getElementById('guildTracked');
  const dashboardGuildName = document.getElementById('dashboardGuildName');
  const dashboardGuildPrefix = document.getElementById('dashboardGuildPrefix');
  const dashboardEventSection = document.getElementById('dashboardEventSection');
  const dashboardEventDuration = document.getElementById('dashboardEventDuration');
  const dashboardEventDelta = document.getElementById('dashboardEventDelta');
  const viewGuildBtn = document.getElementById('viewGuildBtn');
  const changeGuildBtn = document.getElementById('changeGuildBtn');
  const dashboardRefreshBtn = document.getElementById('dashboardRefreshBtn');
  const dashboardEndBtn = document.getElementById('dashboardEndBtn');

  // Define UI functions
  window.showLoggedInUI = function() {
    if (userMenu) userMenu.classList.remove('hidden');
    if (userDashboard) userDashboard.classList.remove('hidden');
    if (headerLoginBtn) headerLoginBtn.classList.add('hidden');
    if (headerUserBtn) {
      headerUserBtn.classList.remove('hidden');
      headerUserBtn.textContent = currentUser;
    }
    if (userDisplayName) userDisplayName.textContent = currentUser;
    loadUserDashboard();
  };

  // Check if user is logged in
  currentUser = getCurrentUser();
  if (currentUser) {
    window.showLoggedInUI();
  } else {
    updateEventButtons();
  }

  async function loadUserDashboard() {
    const userData = await loadUserData();
    if (!userData) {
      logout();
      return;
    }

    trackedGuildDisplay.textContent = userData.trackedGuild ? `Tracking: ${userData.trackedGuild}` : 'No guild tracked';

    if (userData.trackedGuild) {
      noGuildTracked.classList.add('hidden');
      guildTracked.classList.remove('hidden');
      dashboardGuildName.textContent = userData.trackedGuild;
      dashboardGuildPrefix.textContent = '';
      
      // Auto-load the tracked guild's data from Wynncraft API
      searchGuild(userData.trackedGuild);
      
      if (userData.activeEvent) {
        dashboardEventSection.classList.remove('hidden');
        activeEvent = userData.activeEvent;
        displayDashboardEvent();
      } else {
        dashboardEventSection.classList.add('hidden');
      }

      // Load user's event history
      userData.events = userData.events || [];
      displayUserEventHistory(userData.events);
    } else {
      noGuildTracked.classList.remove('hidden');
      guildTracked.classList.add('hidden');
    }
  }

  function displayDashboardEvent() {
    if (!activeEvent) return;

    const currentValue = activeEvent.updates.length > 0
      ? activeEvent.updates[activeEvent.updates.length - 1].value
      : activeEvent.startValue;

    const delta = currentValue - activeEvent.startValue;
    const deltaClass = delta >= 0 ? 'text-green-400' : 'text-red-400';
    const deltaPrefix = delta >= 0 ? '+' : '';

    const elapsed = Date.now() - activeEvent.startTime;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);

    dashboardEventDuration.textContent = `${hours}h ${minutes}m`;
    dashboardEventDelta.textContent = `${deltaPrefix}${delta.toLocaleString()}`;
    dashboardEventDelta.className = `text-xl font-bold ${deltaClass}`;
  }

  function displayUserEventHistory(events) {
    const listEl = document.getElementById('eventHistoryList');
    const noEl = document.getElementById('noEventHistory');

    if (!events || events.length === 0) {
      noEl.classList.remove('hidden');
      listEl.innerHTML = '';
      return;
    }

    noEl.classList.add('hidden');
    listEl.innerHTML = events.map(evt => formatEventCard(evt)).join('');
  }

  headerLoginBtn.addEventListener('click', () => {
    window.location.href = '/login';
  });

  logoutBtn.addEventListener('click', () => {
    logout();
  });

  viewGuildBtn.addEventListener('click', async () => {
    const userData = await loadUserData();
    if (userData && userData.trackedGuild) {
      searchGuild(userData.trackedGuild);
    }
  });

  changeGuildBtn.addEventListener('click', () => {
    // Allow searching new guild
  });

  dashboardRefreshBtn.addEventListener('click', async () => {
    const userData = await loadUserData();
    if (userData && userData.trackedGuild) {
      await searchGuild(userData.trackedGuild);
      refreshEvent();
    }
  });

  dashboardEndBtn.addEventListener('click', async () => {
    if (confirm('End this event and save to history?')) {
      const userData = await loadUserData();
      if (userData && userData.trackedGuild) {
        await searchGuild(userData.trackedGuild);
        endEvent();
        loadUserDashboard();
      }
    }
  });

  // Existing handlers
  searchBtn.addEventListener('click', () => searchGuild(searchInput.value));
  searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchGuild(searchInput.value);
  });

  trackBtn.addEventListener('click', async () => {
    if (!currentGuild || !currentGuild.name) return;
    
    // Update tracked guild in Redis
    await updateUserData({ trackedGuild: currentGuild.name });
    
    const trackBtn = document.getElementById('trackGuildBtn');
    trackBtn.textContent = '✓ Tracking';
    trackBtn.disabled = true;

    loadUserDashboard();
  });

  trackXpBtn.addEventListener('click', () => startEvent('xp'));
  trackWarsBtn.addEventListener('click', () => startEvent('wars'));
  trackMemberXpBtn.addEventListener('click', () => {
    document.getElementById('memberSelectSection').classList.remove('hidden');
  });
  
  startMemberTrackBtn.addEventListener('click', () => {
    const memberSelect = document.getElementById('memberSelect');
    const selectedUsername = memberSelect.value;
    if (!selectedUsername) {
      alert('Please select a member to track');
      return;
    }
    startEvent('member', selectedUsername);
  });

  refreshBtn.addEventListener('click', () => {
    searchGuild(currentGuild.name).then(() => refreshEvent());
  });

  endBtn.addEventListener('click', async () => {
    if (confirm('End this event and save to history?')) {
      endEvent();
      loadUserDashboard();
    }
  });
});
