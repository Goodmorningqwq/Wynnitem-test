const LIVE_PROFILE_ENDPOINT = 'https://summer.gugugaga.net/api/profile';

const elements = {
  input: document.getElementById('playerQueryInput'),
  button: document.getElementById('playerSearchBtn'),
  status: document.getElementById('statusMessage'),
  content: document.getElementById('playerContent'),
  avatar: document.getElementById('playerAvatar'),
  name: document.getElementById('playerName'),
  uuid: document.getElementById('playerUuid'),
  rank: document.getElementById('playerRank'),
  guild: document.getElementById('playerGuild'),
  firstJoin: document.getElementById('playerFirstJoin'),
  onlineBadge: document.getElementById('onlineBadge'),
  coreStatsGrid: document.getElementById('coreStatsGrid'),
  classCards: document.getElementById('classCards'),
  progressionGrid: document.getElementById('progressionGrid')
};

let inFlight = false;

function setStatus(message, tone = 'neutral') {
  elements.status.textContent = message;
  elements.status.classList.remove('text-red-300', 'text-violet-300', 'text-emerald-300', 'text-[var(--text-muted)]');
  if (tone === 'error') {
    elements.status.classList.add('text-red-300');
  } else if (tone === 'progress') {
    elements.status.classList.add('text-violet-300');
  } else if (tone === 'success') {
    elements.status.classList.add('text-emerald-300');
  } else {
    elements.status.classList.add('text-[var(--text-muted)]');
  }
}

function numberText(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'N/A';
  return num.toLocaleString();
}

function dateText(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString();
}

function normalizeClasses(payload) {
  const classesRaw = payload?.characters || payload?.classes || payload?.classesData;
  if (!classesRaw) return [];
  const list = Array.isArray(classesRaw) ? classesRaw : Object.values(classesRaw);
  return list.map((entry) => {
    const className = entry?.type || entry?.classType || entry?.name || 'Unknown';
    const combatLevel = entry?.professions?.combat?.level ?? entry?.combatLevel ?? entry?.level;
    return {
      className: String(className),
      combatLevel: Number(combatLevel || 0),
      gamemode: entry?.gamemode || 'Standard',
      dungeons: entry?.dungeons?.total ?? entry?.dungeonsCompleted ?? 0,
      raids: entry?.raids?.total ?? entry?.raidsCompleted ?? 0,
      mobsKilled: entry?.mobsKilled ?? entry?.mobs?.killed ?? 0,
      playtime: entry?.playtime ?? 0
    };
  }).filter((entry) => entry.className);
}

function normalizeProfile(payload) {
  const globalData = payload?.globalData || {};
  const classes = normalizeClasses(payload);
  const maxCombat = classes.reduce((max, cls) => Math.max(max, Number(cls.combatLevel || 0)), 0);
  const totalPlaytime = classes.reduce((sum, cls) => sum + Number(cls.playtime || 0), 0);

  return {
    username: payload?.username || payload?.name || 'Unknown',
    uuid: payload?.uuid || payload?.id || '',
    online: Boolean(payload?.online),
    rank: payload?.rank || payload?.supportRank || payload?.veteranRank || payload?.rankBadge || 'Player',
    guildName: payload?.guild?.name || payload?.guild?.prefix || 'No Guild',
    firstJoin: payload?.firstJoin || payload?.meta?.firstJoin || null,
    avatarUrl: `https://mc-heads.net/avatar/${encodeURIComponent(payload?.uuid || payload?.username || 'Steve')}/128`,
    coreStats: [
      { label: 'Total Level', value: globalData?.totalLevel ?? payload?.totalLevel ?? 'N/A' },
      { label: 'Highest Combat', value: maxCombat || 'N/A' },
      { label: 'Wars', value: globalData?.wars ?? payload?.wars ?? 'N/A' },
      { label: 'Mobs Killed', value: globalData?.mobsKilled ?? payload?.mobsKilled ?? 'N/A' },
      { label: 'Chests Found', value: globalData?.chestsFound ?? payload?.chestsFound ?? 'N/A' },
      { label: 'Logins', value: globalData?.logins ?? payload?.logins ?? 'N/A' },
      { label: 'Discoveries', value: globalData?.discoveries ?? payload?.discoveries ?? 'N/A' },
      { label: 'Playtime (all classes)', value: totalPlaytime || 'N/A' }
    ],
    classes,
    progression: [
      { label: 'PVP Kills', value: globalData?.pvp?.kills ?? payload?.pvp?.kills ?? 'N/A' },
      { label: 'PVP Deaths', value: globalData?.pvp?.deaths ?? payload?.pvp?.deaths ?? 'N/A' },
      { label: 'Total Dungeons', value: globalData?.dungeons?.total ?? payload?.dungeons?.total ?? 'N/A' },
      { label: 'Total Raids', value: globalData?.raids?.total ?? payload?.raids?.total ?? 'N/A' },
      { label: 'Completed Quests', value: globalData?.completedQuests ?? payload?.completedQuests ?? 'N/A' },
      { label: 'Deaths', value: globalData?.deaths ?? payload?.deaths ?? 'N/A' }
    ]
  };
}

function renderCoreStats(cards) {
  elements.coreStatsGrid.innerHTML = cards.map((card) => `
    <div class="stat-card rounded-xl p-4">
      <p class="text-xs text-[var(--text-muted)] uppercase tracking-[0.14em] mb-1">${card.label}</p>
      <p class="text-xl font-bold text-white">${numberText(card.value)}</p>
    </div>
  `).join('');
}

function renderClasses(classes) {
  if (!classes.length) {
    elements.classCards.innerHTML = '<p class="text-[var(--text-muted)] text-sm">No class data available for this player.</p>';
    return;
  }
  elements.classCards.innerHTML = classes.map((entry) => `
    <div class="neon-panel-soft rounded-xl p-4">
      <div class="flex items-center justify-between mb-2">
        <p class="font-semibold text-white">${entry.className}</p>
        <span class="text-xs px-2 py-1 rounded bg-[rgba(255,79,216,0.16)] text-pink-200 border border-pink-300/30">Lv ${numberText(entry.combatLevel)}</span>
      </div>
      <p class="text-xs text-[var(--text-muted)] mb-3">${entry.gamemode}</p>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div><span class="text-[var(--text-muted)]">Dungeons:</span> <span class="text-white">${numberText(entry.dungeons)}</span></div>
        <div><span class="text-[var(--text-muted)]">Raids:</span> <span class="text-white">${numberText(entry.raids)}</span></div>
        <div><span class="text-[var(--text-muted)]">Mobs:</span> <span class="text-white">${numberText(entry.mobsKilled)}</span></div>
        <div><span class="text-[var(--text-muted)]">Playtime:</span> <span class="text-white">${numberText(entry.playtime)}</span></div>
      </div>
    </div>
  `).join('');
}

function renderProgression(items) {
  elements.progressionGrid.innerHTML = items.map((item) => `
    <div class="neon-panel-soft rounded-xl p-4 flex items-center justify-between gap-3">
      <p class="text-sm text-[var(--text-muted)]">${item.label}</p>
      <p class="text-base font-semibold text-white">${numberText(item.value)}</p>
    </div>
  `).join('');
}

function renderProfile(profile) {
  elements.name.textContent = profile.username;
  elements.uuid.textContent = profile.uuid ? `UUID: ${profile.uuid}` : 'UUID: N/A';
  elements.rank.textContent = profile.rank || 'N/A';
  elements.guild.textContent = profile.guildName || 'N/A';
  elements.firstJoin.textContent = dateText(profile.firstJoin);
  elements.avatar.src = profile.avatarUrl;
  elements.avatar.alt = `${profile.username} avatar`;
  elements.onlineBadge.classList.toggle('hidden', !profile.online);

  renderCoreStats(profile.coreStats);
  renderClasses(profile.classes);
  renderProgression(profile.progression);
  elements.content.classList.remove('hidden');
}

async function searchPlayer() {
  if (inFlight) return;
  const query = String(elements.input.value || '').trim();
  if (!query) {
    setStatus('Enter a player name or UUID first.', 'error');
    return;
  }

  inFlight = true;
  elements.button.disabled = true;
  setStatus('Fetching live player profile from Vercel API...', 'progress');

  try {
    const url = new URL(LIVE_PROFILE_ENDPOINT);
    if (/^[0-9a-f]{32}$/i.test(query) || /^[0-9a-f-]{36}$/i.test(query)) {
      url.searchParams.set('uuid', query);
    } else {
      url.searchParams.set('player', query);
    }
    const response = await fetch(url.toString(), { cache: 'no-store' });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok || !payload) {
      throw new Error(payload?.error || `API Error: ${response.status}`);
    }

    const normalized = normalizeProfile(payload);
    renderProfile(normalized);
    setStatus(`Loaded stats for ${normalized.username}.`, 'success');
  } catch (error) {
    elements.content.classList.add('hidden');
    setStatus(`Unable to load player stats: ${error.message}`, 'error');
  } finally {
    inFlight = false;
    elements.button.disabled = false;
  }
}

elements.button?.addEventListener('click', searchPlayer);
elements.input?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    searchPlayer();
  }
});
