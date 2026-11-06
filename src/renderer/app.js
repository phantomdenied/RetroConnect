'use strict';
/* global rc */

// ----- tiny DOM helper -------------------------------------------------------

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM, so the CSP needn't allow inline styles
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
function mount(target, ...nodes) { target.replaceChildren(...nodes.flat().filter(Boolean)); }

// ----- app state -------------------------------------------------------------

let S = null; // state from the main process
let lib = null; // { rows, cores, buddyOnline, romsDir }
let view = 'games';
let filter = 'all';
let query = '';
let revealSecret = false;
let draft = null; // settings being edited
const logs = [];

const SYSTEMS = {
  nes: 'NES', fds: 'FDS', unf: 'NES', sfc: 'SNES', smc: 'SNES', md: 'MD', gen: 'MD', smd: 'MD',
  sms: 'SMS', gg: 'GG', gb: 'GB', gbc: 'GBC', gba: 'GBA', pce: 'PCE', a26: '2600', zip: 'ARC',
  n64: 'N64', z64: 'N64', v64: 'N64', cue: 'CD', chd: 'CD', iso: 'CD',
};
const STATUS_TEXT = {
  both: 'Ready to play', different: 'Different version', theirs: 'Buddy has it', mine: 'Only you', unknown: 'Yours',
};

const buddyName = () => (S && S.buddy && S.buddy.nickname) || 'your buddy';

/** "Legend of Zelda, The - A Link to the Past (USA) [!].sfc" -> "The Legend of Zelda - A Link to the Past" */
function gameTitle(p) {
  const base = p.split('/').pop().replace(/\.[^.]+$/, '');
  let t = base.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(.+?), (The|A|An)(?=$| - |: )/, '$2 $1');
  // "contra" -> "Contra" for all-lowercase file names
  if (t && t === t.toLowerCase()) t = t.replace(/\b([a-z])/g, (c) => c.toUpperCase());
  return t || base;
}
function regionTag(p) {
  const m = /\(([^)]*(USA|Europe|Japan|World|Korea|Brazil|Australia|Germany|France|Spain|Italy)[^)]*)\)/i.exec(p);
  return m ? m[1] : null;
}
function timeAgo(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function cover(r) {
  const tile = h('div', { class: 'sys' }, r.systemShort || systemOf(r.path));
  if (!r.thumb) return tile;
  const img = h('img', { class: 'cover', src: `rcthumb://cover/${r.sha}`, alt: '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(tile));
  return img;
}
function starButton(r) {
  return h('button', {
    class: `star ${r.favorite ? 'on' : ''}`, title: r.favorite ? 'Remove from favorites' : 'Add to favorites',
    onclick: (e) => { e.stopPropagation(); act(async () => { await rc.toggleFavorite(r.sha); await loadLibrary(); }); },
  }, r.favorite ? '★' : '☆');
}
function metaLine(r, size, extra = '') {
  const bits = [];
  const reg = regionTag(r.path);
  if (reg) bits.push(reg);
  bits.push(fmtBytes(size));
  if (extra) bits.push(extra);
  if (r.lastPlayed) bits.push(`played ${timeAgo(r.lastPlayed)}${r.playCount > 1 ? ` · ${r.playCount} times` : ''}`);
  return bits.join(' · ');
}
function systemOf(p) {
  const ext = (p.split('.').pop() || '').toLowerCase();
  return SYSTEMS[ext] || ext.slice(0, 4) || '?';
}
function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

// ----- feedback --------------------------------------------------------------

let toastTimer = null;
function toast(message, kind = 'info') {
  const t = $('#toast');
  t.textContent = message;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 7000 : 3500);
}

async function act(fn, { success } = {}) {
  try {
    const r = await fn();
    if (success) toast(typeof success === 'function' ? success(r) : success);
    return r;
  } catch (err) {
    toast(err.message, 'error');
    addLog({ message: err.message, level: 'error', at: Date.now() });
    return undefined;
  }
}

function addLog(entry) {
  logs.push(entry);
  if (logs.length > 300) logs.shift();
  const status = $('#activity-status');
  status.textContent = entry.message;
  status.className = `activity-status ${entry.level}`;
  const t = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const li = h('li', { class: entry.level }, h('time', {}, t), entry.message);
  const log = $('#log');
  log.append(li);
  while (log.children.length > 300) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}

let progressHide = null;
function showProgress({ label, done, total, percent, count }) {
  const box = $('#progress');
  const pct = total ? Math.min(100, (100 * done) / total) : 100;
  box.hidden = false;
  box.querySelector('.progress-fill').style.width = `${pct}%`;
  box.querySelector('.progress-label').textContent = count
    ? label
    : percent
    ? `${label} · ${pct.toFixed(0)}%`
    : `${label.split('/').pop()} · ${pct.toFixed(0)}% of ${fmtBytes(total)}`;
  clearTimeout(progressHide);
  if (done >= total) progressHide = setTimeout(() => { box.hidden = true; }, 1500);
}

// ----- rendering -------------------------------------------------------------

function render() {
  if (!S) return;
  renderBuddyCard();
  renderBanner();
  renderDiscord();
  $('#nav-friend').textContent = S.buddy && S.buddy.nickname ? `${S.buddy.nickname}'s games` : "Friend's games";
  for (const v of ['games', 'friend', 'buddy', 'retroarch', 'settings']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'games') renderGames();
  if (view === 'friend') renderFriend();
  if (view === 'buddy') renderConnect();
  if (view === 'settings') renderSettings();
  if (view === 'retroarch') renderRetroArch();
  if (view === 'friend') renderFriend();
  renderWizard();
}

function renderBuddyCard() {
  const b = S.buddy || {};
  let dot = '', who = 'No buddy set', sub = 'Add their address in Connect';
  if (b.status === 'online') {
    dot = b.session ? 'hosting' : 'online';
    who = b.nickname;
    sub = b.session ? `Hosting ${gameTitle(b.session.rom.path)}` : `Online · ${b.romCount} games`;
  } else if (b.status === 'offline') {
    dot = 'offline';
    who = S.config.peerAddress;
    sub = 'Offline or unreachable';
  } else if (b.status === 'checking') {
    who = S.config.peerAddress;
    sub = 'Checking…';
  }
  mount($('#buddy-card'),
    h('div', { class: 'who' }, h('span', { class: `dot ${dot}` }), h('span', {}, who)),
    h('div', { class: 'sub' }, sub));
}

/** "You're Player 1 · Sam is Player 2" from what RetroArch reports, or a fallback. */
function liveplayerTag(fallback) {
  const np = S.netplay;
  if (!np) return fallback ? h('span', { class: 'player-tag' }, fallback) : null;
  if (np.swapping) return h('span', { class: 'player-tag' }, 'Swapping players…');
  const me = np.me ? `You're Player ${np.me}` : 'You\'re watching';
  const them = np.other ? ` · ${buddyName()} is Player ${np.other}` : '';
  return h('span', { class: 'player-tag' }, me + them);
}

/** Swap Player 1 and Player 2 mid-game (taking turns in single-player games). */
function swapButton() {
  const np = S.netplay;
  if (!np) return null;
  return h('button', {
    class: 'btn', disabled: np.swapping || !np.other && !np.me,
    title: `Swap who is Player 1 without stopping the game. Handy for taking turns in single-player games.`,
    onclick: () => act(() => rc.swapPlayers(), { success: (r) => (r && r.requested ? `Asked ${buddyName()}'s app to swap` : 'Swapped players') }),
  }, '⇄ Swap players');
}

function renderBanner() {
  const b = S.buddy || {};
  let node = null;
  if (S.hosting) {
    node = h('div', { class: 'banner hosting' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `You're hosting ${gameTitle(S.hosting.rom.path)}`,
          liveplayerTag(`You're Player ${S.config.hostPlayer} · ${buddyName()} is Player ${3 - S.config.hostPlayer}`)),
        h('div', { class: 'muted small' },
          b.status === 'online'
            ? `${b.nickname} has been notified. Their app will download anything they're missing, then connect.`
            : `Waiting for your buddy to open RetroConnect and click Join.`),
        b.status === 'online' && b.retroarchVersion && S.retroarch.version && b.retroarchVersion !== S.retroarch.version
          ? h('div', { class: 'warn-text small' }, `⚠ ${b.nickname} has RetroArch ${b.retroarchVersion}, you have ${S.retroarch.version}. Ask them to click "Match" on their invite to avoid desyncs.`)
          : null),
      swapButton(),
      h('button', { class: 'btn danger', onclick: () => act(() => rc.stopHosting()) }, 'Stop hosting'));
  } else if (S.playing) {
    node = h('div', { class: 'banner hosting' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `Playing ${gameTitle(S.playing.rom.path)} with ${S.playing.host}`, liveplayerTag(null)),
        h('div', { class: 'muted small' }, 'Close RetroArch to end the session.')),
      swapButton());
  } else if (b.status === 'online' && b.session) {
    const s = b.session;
    node = h('div', { class: 'banner' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `${s.host_nickname} is hosting ${gameTitle(s.rom.path)}`,
          s.host_player ? h('span', { class: 'player-tag' }, `You'll be Player ${3 - Number(s.host_player)}`) : null),
        h('div', { class: 'muted small' },
          `${s.core.name.replace(/_libretro$/, '')} · ${fmtBytes(s.rom.size)}. Anything you're missing is downloaded first.`),
        compatNotes()),
      h('button', {
        class: 'btn primary', disabled: Boolean(S.busy),
        onclick: () => act(async () => { await rc.join(); await loadLibrary(); }, { success: 'Starting RetroArch…' }),
      }, S.busy ? S.busy + '…' : 'Join game'),
      S.discord ? discordButton('btn') : null);
  } else if (b.status === 'online' && b.suggestion && !dismissed.has(b.suggestion.id)) {
    node = suggestionBanner(b.suggestion);
  } else if (S.mySuggestion) {
    node = h('div', { class: 'banner suggest' },
      h('span', { class: 'emoji' }, '💬'),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `You suggested ${gameTitle(S.mySuggestion.rom.path)}`),
        h('div', { class: 'muted small' }, `${buddyName()} sees it in their app. Host it when you're both ready.`)),
      h('button', { class: 'btn small', onclick: () => act(() => rc.clearSuggestion()) }, 'Cancel'));
  }
  mount($('#banner'), updateBanner(), node);
}

// ----- friend's library ------------------------------------------------------

let friendQuery = '';
let friendFilter = 'all';

function renderFriend() {
  const root = $('#view-friend');
  const b = S.buddy || {};
  const name = b.nickname || 'Your friend';
  const rows = (lib ? lib.rows : []).filter((r) => r.theirs);
  const head = h('div', { class: 'view-head' },
    h('h1', {}, `${name}'s games`),
    h('button', { class: 'btn', onclick: () => act(() => loadLibrary(true)) }, 'Refresh'));
  if (b.status !== 'online' && !rows.length) {
    return mount(root, head, h('div', { class: 'empty' },
      h('h2', {}, b.status === 'unset' ? 'No friend connected yet' : `${name} is offline`),
      h('p', {}, b.status === 'unset' ? 'Add your friend on the Connect page to see their games.' : 'Their library shows up here when RetroConnect is open on their PC.')));
  }
  const counts = {
    all: rows.length,
    missing: rows.filter((r) => r.status === 'theirs' || r.status === 'different').length,
    both: rows.filter((r) => r.status === 'both').length,
  };
  const q = friendQuery.trim().toLowerCase();
  const shown = rows.filter((r) => (!q || r.path.toLowerCase().includes(q))
    && (friendFilter === 'all' || (friendFilter === 'both' ? r.status === 'both' : r.status !== 'both')));
  const busy = Boolean(S.busy);
  mount(root, head,
    h('p', { class: 'muted', style: 'margin-top:-6px' }, `Ask ${name} to play something: they get a pop-up with a Host button. Anything you don't have downloads automatically when you join.`),
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: `Search ${name}'s games`, value: friendQuery, oninput: (e) => { friendQuery = e.target.value; renderFriend(); } }),
      h('div', { class: 'chips' }, [['all', 'All'], ['missing', "You don't have"], ['both', 'You both have']].map(([k, label]) =>
        h('button', { class: `chip ${friendFilter === k ? 'active' : ''}`, onclick: () => { friendFilter = k; renderFriend(); } }, label, h('span', { class: 'count' }, counts[k]))))),
    shown.length ? h('div', { class: 'games' }, shown.map((r) => h('div', { class: 'game' },
      cover(r),
      h('div', { style: 'min-width:0' },
        h('div', { class: 'title', title: r.path }, gameTitle(r.path)),
        h('div', { class: 'meta', title: r.path }, metaLine(r, r.theirs.size))),
      h('span', { class: `badge ${r.status === 'both' ? 'both' : r.status === 'different' ? 'different' : 'theirs'}` },
        r.status === 'both' ? 'You have it too' : r.status === 'different' ? 'Your copy differs' : "You don't have it"),
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn small primary', disabled: b.status !== 'online',
          title: `${name} gets a pop-up asking to host ${gameTitle(r.path)}`,
          onclick: () => act(() => rc.suggest(r.theirs.sha256), { success: `Asked ${name} to play ${gameTitle(r.path)}` }),
        }, 'Ask to play'),
        r.status !== 'both' ? h('button', {
          class: 'btn small cyan', disabled: busy || b.status !== 'online',
          onclick: () => act(async () => { await rc.sync([r.theirs.sha256]); await loadLibrary(); }, { success: `Got ${gameTitle(r.path)}` }),
        }, 'Get it') : null)))) : h('div', { class: 'empty' }, rows.length ? 'No games match.' : `${name} hasn't added any games yet.`));
  const input = root.querySelector('input[type=search]');
  if (input && friendQuery) { input.focus(); input.setSelectionRange(friendQuery.length, friendQuery.length); }
}

// ----- suggestions -----------------------------------------------------------

const dismissed = new Set();
let pick = null; // row picked by "Pick a game for us"
const recentPicks = [];

function rowBySha(sha) {
  return lib ? lib.rows.find((r) => (r.mine && r.mine.sha256 === sha) || (r.theirs && r.theirs.sha256 === sha)) : null;
}

function suggestionBanner(sug) {
  const row = rowBySha(sug.rom.sha256);
  const haveIt = row && row.mine && row.mine.sha256 === sug.rom.sha256;
  const busy = Boolean(S.busy) || Boolean(S.hosting) || Boolean(S.playing);
  return h('div', { class: 'banner suggest' },
    h('span', { class: 'emoji' }, '💬'),
    h('div', { class: 'grow' },
      h('div', { class: 'big' }, `${sug.from} wants to play ${gameTitle(sug.rom.path)}`),
      h('div', { class: 'muted small' }, haveIt ? 'You have it. Host it and they get an invite.' : `You don't have it yet (${fmtBytes(sug.rom.size)}). One click gets it from them.`)),
    haveIt
      ? h('button', { class: 'btn primary', disabled: busy, onclick: () => act(() => rc.host(sug.rom.sha256), { success: `Hosting ${gameTitle(sug.rom.path)}` }) }, 'Host it')
      : h('button', {
        class: 'btn cyan', disabled: busy,
        onclick: () => act(async () => { await rc.sync([sug.rom.sha256]); await loadLibrary(); }, { success: `Got ${gameTitle(sug.rom.path)}. Now hit Host it.` }),
      }, 'Get it'),
    h('button', { class: 'btn small', onclick: () => { dismissed.add(sug.id); renderBanner(); } }, 'Not now'));
}

function pickGame() {
  const rows = lib ? lib.rows : [];
  // Prefer games you both have; otherwise anything one of you can host.
  let pool = rows.filter((r) => r.status === 'both');
  if (!pool.length) pool = rows.filter((r) => r.mine || r.theirs);
  if (!pool.length) return toast('No games yet. Add some ROMs first.', 'error');
  const fresh = pool.filter((r) => !recentPicks.includes(r.path));
  const from = fresh.length ? fresh : pool;
  // Favorites are twice as likely; games played in the last 3 days much less.
  const weight = (r) => (r.favorite ? 2 : 1) * (r.lastPlayed && Date.now() - r.lastPlayed < 3 * 864e5 ? 0.25 : 1);
  let roll = Math.random() * from.reduce((n, r) => n + weight(r), 0);
  pick = from.find((r) => (roll -= weight(r)) <= 0) || from[from.length - 1];
  recentPicks.push(pick.path);
  if (recentPicks.length > Math.min(5, pool.length - 1)) recentPicks.shift();
  renderGames();
}

function pickCard() {
  if (!pick) return null;
  const r = rowBySha((pick.mine || pick.theirs).sha256) || pick;
  const buddyOnline = S.buddy.status === 'online';
  return h('div', { class: 'pick-card' },
    r.thumb ? cover(r) : h('div', { class: 'pick-dice' }, '🎲'),
    h('div', { class: 'grow' },
      h('div', { class: 'muted small' }, 'How about…'),
      h('div', { class: 'pick-title' }, gameTitle(r.path)),
      h('div', { class: 'muted small' }, `${r.systemShort || systemOf(r.path)} · ${r.status === 'both' ? 'you both have it' : STATUS_TEXT[r.status] || ''}`)),
    h('div', { class: 'actions' },
      r.mine ? h('button', {
        class: 'btn primary', disabled: !r.coreInstalled || Boolean(S.hosting || S.playing),
        onclick: () => act(async () => { await rc.host(r.mine.sha256); pick = null; renderGames(); }, { success: `Hosting ${gameTitle(r.path)}` }),
      }, 'Host it') : null,
      buddyOnline ? h('button', {
        class: 'btn cyan',
        onclick: () => act(async () => { await rc.suggest((r.mine || r.theirs).sha256); pick = null; renderGames(); }, { success: `Suggested to ${buddyName()}` }),
      }, `Suggest to ${buddyName()}`) : null,
      h('button', { class: 'btn', onclick: pickGame }, 'Another one'),
      h('button', { class: 'btn small', title: 'Close', onclick: () => { pick = null; renderGames(); } }, '✕')));
}

// ----- Discord ---------------------------------------------------------------

function discordButton(cls = 'btn small') {
  if (!S.discord) return null;
  return h('button', { class: `${cls} discord`, onclick: () => act(() => rc.openUrl(S.discord.url)) }, 'Open Discord');
}

function renderDiscord() {
  const d = S.discord;
  mount($('#discord-slot'), d ? h('div', { class: 'discord-card' },
    discordButton('btn'),
    h('div', { class: 'muted small' }, d.from === 'you' ? 'Your group chat' : `Shared by ${d.from}`)) : null);
}

// ----- app updates -----------------------------------------------------------

let hiddenUpdate = null;
function updateBanner() {
  const u = S.update;
  if (!u || !u.available || hiddenUpdate === u.latest) return null;
  return h('div', { class: 'banner update' },
    h('span', { class: 'emoji' }, '⬆️'),
    h('div', { class: 'grow' },
      h('div', { class: 'big' }, `RetroConnect ${u.latest} is available`),
      h('div', { class: 'muted small' }, u.notes || `You have ${u.current}. Download it, run it, and it updates in place. Your settings stay.`)),
    h('button', { class: 'btn primary', onclick: () => act(() => rc.openUrl(u.url)) }, 'Download update'),
    h('button', { class: 'btn small', onclick: () => { hiddenUpdate = u.latest; renderBanner(); } }, 'Later'));
}

// Dropdown filters on the Games page ('' = any).
const facets = { system: '', language: '', kind: '', players: '', genre: '' };
const LANG_NAMES = {
  en: 'English', ja: 'Japanese', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', nl: 'Dutch',
  pt: 'Portuguese', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish', zh: 'Chinese', ko: 'Korean',
  pl: 'Polish', ru: 'Russian', ca: 'Catalan', el: 'Greek', cs: 'Czech', hu: 'Hungarian', tr: 'Turkish', ar: 'Arabic',
};
const KIND_NAMES = { official: 'Official releases', hack: 'ROM hacks', homebrew: 'Homebrew' };

/** Does a row pass the dropdown filters (optionally ignoring one of them)? */
function passesFacets(r, skip = null) {
  if (skip !== 'system' && facets.system && r.system !== facets.system) return false;
  if (skip !== 'language' && facets.language && !(r.languages || []).includes(facets.language)) return false;
  if (skip !== 'kind' && facets.kind && r.kind !== facets.kind) return false;
  if (skip !== 'players' && facets.players === 'single' && r.players !== 1) return false;
  if (skip !== 'players' && facets.players === 'multi' && !(r.players >= 2)) return false;
  if (skip !== 'genre' && facets.genre && r.genre !== facets.genre) return false;
  return true;
}

function facetBar(rows) {
  // Each dropdown counts games that match the *other* filters, so the numbers
  // say what you'd get by picking that option.
  const tally = (key, valuesOf) => {
    const m = new Map();
    for (const r of rows) if (passesFacets(r, key)) for (const v of valuesOf(r)) if (v) m.set(v, (m.get(v) || 0) + 1);
    return m;
  };
  const select = (key, anyLabel, options) => h('select', {
    class: `facet ${facets[key] ? 'active' : ''}`, 'aria-label': anyLabel,
    onchange: (e) => { facets[key] = e.target.value; renderGames(); },
  },
  h('option', { value: '' }, anyLabel),
  options.map(([value, label, n]) => h('option', { value, selected: facets[key] === value }, `${label} (${n})`)));
  const byCount = (m, names = {}) => [...m].sort((a, b) => b[1] - a[1]).map(([v, n]) => [v, names[v] || v, n]);
  const byName = (m) => [...m].sort((a, b) => a[0].localeCompare(b[0])).map(([v, n]) => [v, v, n]);
  const players = tally('players', (r) => [r.players === 1 ? 'single' : r.players >= 2 ? 'multi' : null]);
  const anySet = Object.values(facets).some(Boolean);
  return h('div', { class: 'facets' },
    select('system', 'All systems', byName(tally('system', (r) => [r.system]))),
    select('language', 'Any language', byCount(tally('language', (r) => r.languages || []), LANG_NAMES)),
    select('kind', 'Official, hacks & homebrew', ['official', 'hack', 'homebrew']
      .map((k) => [k, KIND_NAMES[k], tally('kind', (r) => [r.kind]).get(k) || 0])),
    select('players', 'Any number of players', [['single', 'Single player', players.get('single') || 0], ['multi', 'Multiplayer (2+)', players.get('multi') || 0]]),
    select('genre', 'Any genre', byName(tally('genre', (r) => [r.genre]))),
    anySet ? h('button', { class: 'btn small', onclick: () => { for (const k of Object.keys(facets)) facets[k] = ''; renderGames(); } }, 'Clear filters') : null);
}

function filteredRows() {
  if (!lib) return [];
  const q = query.trim().toLowerCase();
  const rows = lib.rows.filter((r) => {
    if (q && !r.path.toLowerCase().includes(q) && !gameTitle(r.path).toLowerCase().includes(q)) return false;
    if (!passesFacets(r)) return false;
    if (filter === 'fav') return r.favorite;
    if (filter === 'recent') return Boolean(r.lastPlayed);
    if (filter === 'ready') return r.status === 'both';
    if (filter === 'download') return r.status === 'theirs' || r.status === 'different';
    if (filter === 'mine') return r.status === 'mine' || r.status === 'unknown';
    return true;
  });
  if (filter === 'recent') rows.sort((a, b) => b.lastPlayed - a.lastPlayed);
  else rows.sort((a, b) => (b.favorite - a.favorite) || gameTitle(a.path).localeCompare(gameTitle(b.path)));
  return rows;
}

function gameRow(r) {
  const canHost = r.mine && !S.hosting && !S.playing;
  const actions = [];
  if (r.mine) {
    actions.push(h('button', {
      class: 'btn small primary', disabled: !canHost || !r.coreInstalled,
      title: !r.coreInstalled
        ? (r.coreName ? `${r.coreName} isn't installed. Install it on the RetroArch page.` : 'No core set for this file type (Settings → Cores)')
        : `Start ${gameTitle(r.path)} and invite ${buddyName()}`,
      onclick: () => act(() => rc.host(r.mine.sha256), { success: `Hosting ${gameTitle(r.path)}` }),
    }, 'Host'));
  }
  if (r.status === 'theirs' || r.status === 'different') {
    actions.push(h('button', {
      class: 'btn small cyan', disabled: Boolean(S.busy),
      title: r.status === 'different' ? 'Replace your copy with your buddy\'s (yours is kept as .old)' : '',
      onclick: () => act(async () => { await rc.sync([r.theirs.sha256]); await loadLibrary(); },
        { success: `Got ${gameTitle(r.path)}` }),
    }, r.status === 'different' ? 'Use buddy\'s' : 'Get it'));
  }
  if (S.buddy.status === 'online' && (r.mine || r.theirs)) {
    actions.push(h('button', {
      class: 'btn small', title: `Ask ${buddyName()} to play this`,
      onclick: () => act(() => rc.suggest((r.mine || r.theirs).sha256), { success: `Suggested to ${buddyName()}` }),
    }, 'Suggest'));
  }
  const core = [
    r.coreName ? r.coreName.replace(/_libretro$/, '') : 'no core set',
    r.players === 1 ? '1 player' : r.players ? `${r.players} players` : null,
    r.genre || null,
    r.kind === 'hack' ? 'hack' : r.kind === 'homebrew' ? 'homebrew' : null,
  ].filter(Boolean).join(' · ');
  const entry = r.mine || r.theirs;
  return h('div', { class: 'game' },
    cover(r),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'title', title: r.path }, starButton(r), gameTitle(r.path)),
      h('div', { class: 'meta', title: r.path }, metaLine(r, entry.size, `${core}${r.mine && !r.coreInstalled && r.coreName ? ' (not installed)' : ''}`))),
    h('span', { class: `badge ${r.status}` }, r.status === 'theirs' ? `${buddyName()} has it` : STATUS_TEXT[r.status]),
    h('div', { class: 'actions' }, actions));
}

function renderGames() {
  const root = $('#view-games');
  const rows = lib ? lib.rows : [];
  const count = (pred) => rows.filter(pred).length;
  const needs = count((r) => r.status === 'theirs' || r.status === 'different');
  const chips = [
    ['all', 'All', rows.length],
    ['ready', 'Ready to play', count((r) => r.status === 'both')],
    ['download', 'Needs download', needs],
    ['mine', 'Only mine', count((r) => r.status === 'mine' || r.status === 'unknown')],
    ['fav', '★ Favorites', count((r) => r.favorite)],
    ['recent', 'Recently played', count((r) => r.lastPlayed)],
  ];
  const search = h('input', {
    type: 'search', placeholder: 'Search games', value: query,
    oninput: (e) => { query = e.target.value; renderGameList(); },
  });
  mount(root,
    h('div', { class: 'view-head' },
      h('h1', {}, 'Games'),
      h('label', { class: 'p1-select', title: 'Who controls Player 1 when you host. The other person gets Player 2.' }, 'When I host, Player 1 is',
        h('select', { onchange: (e) => act(() => rc.saveSettings({ hostPlayer: Number(e.target.value) }), { success: 'Saved' }) },
          h('option', { value: '1', selected: S.config.hostPlayer === 1 }, 'me'),
          h('option', { value: '2', selected: S.config.hostPlayer === 2 }, buddyName()))),
      h('button', { class: 'btn', onclick: pickGame }, '🎲 Pick a game for us'),
      h('button', { class: 'btn', onclick: () => act(() => loadLibrary(true)) }, 'Refresh'),
      lib && lib.buddyOnline && needs
        ? h('button', {
          class: 'btn cyan', disabled: Boolean(S.busy),
          onclick: () => act(async () => { await rc.sync(); await loadLibrary(); }, { success: 'Library synced' }),
        }, `Get all ${needs} from ${buddyName()}`)
        : null),
    h('div', { class: 'toolbar' },
      search,
      h('div', { class: 'chips' }, chips.map(([key, label, n]) => h('button', {
        class: `chip ${filter === key ? 'active' : ''}`,
        onclick: () => { filter = key; renderGames(); },
      }, label, h('span', { class: 'count' }, n))))),
    facetBar(rows),
    pickCard(),
    h('div', { id: 'game-list', class: 'games' }));
  renderGameList();
}

function renderGameList() {
  const list = $('#game-list');
  if (!list) return;
  if (!lib) return mount(list, h('div', { class: 'empty' }, 'Scanning your library…'));
  const rows = filteredRows();
  if (!lib.rows.length) {
    return mount(list, h('div', { class: 'empty' },
      h('h2', {}, 'No games yet'),
      h('p', {}, 'Put ROMs you own in your ROM folder (subfolders are fine), then hit Refresh.'),
      h('p', { class: 'mono' }, lib.romsDir),
      h('button', { class: 'btn', onclick: () => act(() => rc.openPath(lib.romsDir)) }, 'Open ROM folder'),
      S.buddy.status === 'online' ? null : h('p', { class: 'small' }, 'Once your buddy is connected, their games show up here too.')));
  }
  if (!rows.length) return mount(list, h('div', { class: 'empty' }, 'No games match.'));
  mount(list, rows.map(gameRow));
}

function modePicker(current, onPick) {
  const modes = [
    ['tailscale', 'Tailscale', 'Both install Tailscale. Encrypted, no router setup. Recommended.'],
    ['direct', 'Direct', 'Same home network, or the host forwards ports.'],
    ['relay', 'Relay', 'Gameplay goes through a libretro relay. File sync still needs a direct route.'],
  ];
  return h('div', { class: 'modes' }, modes.map(([key, name, desc]) => h('button', {
    class: `mode ${current === key ? 'active' : ''}`, type: 'button', onclick: () => onPick(key),
  }, h('strong', {}, name), h('span', {}, desc))));
}

function modeHelp(cfg) {
  if (cfg.connectionMode === 'tailscale') return tailscalePanel();
  if (cfg.connectionMode === 'relay') {
    return h('div', { class: 'callout' },
      `Netplay goes through the ${cfg.relayServer} relay, and the guest joins from RetroArch → Netplay → Refresh Host List. `,
      `Downloading games still needs TCP ${cfg.syncPort} reachable on the host (Tailscale or a port forward).`);
  }
  return h('div', { class: 'callout info' },
    'On the same Wi-Fi, use the LAN address. Over the internet, whoever hosts forwards these TCP ports on their router: ',
    h('b', {}, `${cfg.syncPort}`), ' (file sync) and ', h('b', {}, `${cfg.netplayPort}`),
    ' (netplay). Use their public IP as the address. Files travel unencrypted in this mode; Tailscale is safer.');
}

// This PC's internet address, looked up by the app (no "what is my IP" site needed).
let publicIp = { address: null, error: null, loading: false };

function loadPublicIp(refresh = false) {
  if (publicIp.loading) return;
  publicIp = { ...publicIp, loading: true, error: null };
  renderConnect();
  rc.publicIp({ refresh })
    .then((r) => { publicIp = { address: r.address, error: null, loading: false }; })
    .catch((err) => { publicIp = { address: null, error: err.message, loading: false }; })
    .then(() => { if (view === 'buddy') renderConnect(); });
}

function publicIpRow(cfg) {
  // Direct mode over the internet is when your buddy needs it: look it up right away.
  if (cfg.connectionMode === 'direct' && !publicIp.address && !publicIp.error && !publicIp.loading) {
    setTimeout(() => loadPublicIp(), 0);
  }
  const tag = h('span', { class: 'tag' }, 'Internet');
  let body;
  if (publicIp.address) {
    body = [h('span', { class: 'mono' }, publicIp.address), tag,
      h('button', { class: 'link-btn small', onclick: () => act(() => rc.copy(publicIp.address), { success: 'Copied' }) }, 'Copy')];
  } else if (publicIp.loading) {
    body = [h('span', { class: 'muted small' }, 'Looking up your internet address…'), tag];
  } else {
    body = [h('button', { class: 'link-btn small', onclick: () => loadPublicIp(true) }, publicIp.error ? 'Try again' : 'Show my internet address'), tag];
  }
  return [
    h('div', { class: 'addr' }, body),
    publicIp.error ? h('div', { class: 'hint small', style: 'color:var(--bad)' }, publicIp.error) : null,
    h('div', { class: 'hint small muted' }, cfg.connectionMode === 'tailscale'
      ? 'With Tailscale, send the Tailscale address. The internet address is only for Direct mode.'
      : 'On the same Wi-Fi, send the LAN address. Over the internet, send the Internet one (the host also needs the ports forwarded).'),
  ];
}

function renderConnect() {
  const cfg = S.config;
  const b = S.buddy || {};
  const addrInput = h('input', { type: 'text', value: cfg.peerAddress, placeholder: 'e.g. 100.101.102.103 or 192.168.1.20' });
  const save = (partial, msg) => act(() => rc.saveSettings(partial), { success: msg });
  const statusLine = {
    online: h('span', {}, h('span', { class: 'dot online', style: 'display:inline-block;margin-right:6px' }), `Connected to ${b.nickname}`),
    offline: h('span', { style: 'color:var(--bad)' }, b.error || 'Unreachable'),
    checking: h('span', { class: 'muted' }, 'Checking…'),
    unset: h('span', { class: 'muted' }, 'No address yet'),
  }[b.status || 'unset'];

  mount($('#view-buddy'),
    h('div', { class: 'view-head' }, h('h1', {}, 'Connect with your buddy')),
    h('div', { class: 'card' },
      h('h2', {}, 'How you connect'),
      modePicker(cfg.connectionMode, (m) => save({ connectionMode: m }, `Switched to ${m}`)),
      modeHelp(cfg)),
    h('div', { class: 'grid-2', style: 'margin-top:16px' },
      h('div', { class: 'card' },
        h('h2', {}, "Your buddy's address"),
        h('div', { class: 'field' },
          h('div', { class: 'row' }, addrInput,
            h('button', { class: 'btn primary', onclick: () => save({ peerAddress: addrInput.value }, 'Saved') }, 'Save')),
          h('div', { class: 'hint' }, 'The address they see on their Connect page.')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Status'), h('dd', {}, statusLine),
          b.status === 'online' ? [
            h('dt', {}, 'Their system'), h('dd', {}, b.platform),
            h('dt', {}, 'RetroArch'), h('dd', {},
              b.retroarchVersion || '?',
              S.retroarch.version && b.retroarchVersion && S.retroarch.version !== b.retroarchVersion
                ? h('span', { style: 'color:var(--warn)' }, ` (you have ${S.retroarch.version}; matching versions avoid desyncs)`) : null),
            h('dt', {}, 'Games'), h('dd', {}, b.romCount),
          ] : null),
        b.status === 'offline' ? h('div', { class: 'callout bad' }, 'Check that:',
          h('ul', { class: 'tight' },
            h('li', {}, 'RetroConnect is open on their PC'),
            h('li', {}, 'You both have the same shared secret'),
            h('li', {}, `Port ${cfg.syncPort} is reachable (Tailscale running, or forwarded on their router)`))) : null),
      h('div', { class: 'card' },
        h('h2', {}, 'Your details (send these to your buddy)'),
        h('div', { class: 'label', style: 'font-weight:650;font-size:13px' }, 'Your addresses'),
        S.addresses.length
          ? S.addresses.map((a) => h('div', { class: 'addr' },
            h('span', { class: 'mono' }, a.address), h('span', { class: 'tag' }, a.kind === 'tailscale' ? 'Tailscale' : 'LAN'),
            h('button', { class: 'link-btn small', onclick: () => act(() => rc.copy(a.address), { success: 'Copied' }) }, 'Copy')))
          : h('div', { class: 'muted small' }, 'No network found'),
        publicIpRow(cfg),
        h('div', { class: 'field', style: 'margin-top:14px' },
          h('div', { class: 'label' }, 'Shared secret'),
          h('div', { class: 'row' },
            h('span', { class: 'secret', style: 'flex:1' }, revealSecret ? cfg.sharedSecret : '•'.repeat(16)),
            h('button', { class: 'btn small', onclick: () => { revealSecret = !revealSecret; render(); } }, revealSecret ? 'Hide' : 'Show'),
            h('button', { class: 'btn small', onclick: () => act(() => rc.copy(cfg.sharedSecret), { success: 'Secret copied' }) }, 'Copy')),
          h('div', { class: 'hint' }, 'You both need the same one. Send it privately.')),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Sharing'), h('dd', {}, S.server.running
            ? `On, port ${S.server.port}`
            : (S.server.error ? h('span', { style: 'color:var(--bad)' }, S.server.error) : 'Off')),
          h('dt', {}, 'Your system'), h('dd', {}, S.platform)))),
    cfg.connectionMode === 'direct' ? portCheckCard() : null,
    connectionCheckCard(),
    discordCard());
}

/** Direct mode: are this PC's ports open from the internet? Works without the buddy. */
function portCheckCard() {
  const r = S.portCheck;
  const lan = (S.addresses.find((a) => a.kind === 'lan') || {}).address || 'this PC';
  let body = h('p', { class: 'muted small', style: 'margin:0' },
    `Whoever hosts over the internet needs TCP ${S.config.syncPort} (file sync) and ${S.config.netplayPort} (netplay) open. `,
    'This asks portchecker.io to try them from outside, so it sees your internet address. Your buddy doesn\'t need to be online.');
  if (r && r.running) body = h('div', { class: 'pad-waiting', style: 'margin:0' }, h('span', { class: 'pulse' }), 'Checking from the internet… (up to 20 seconds)');
  else if (r && r.error) body = h('div', { class: 'bad-text' }, r.error);
  else if (r && r.ports) {
    const closed = r.ports.filter((p) => !p.open);
    body = h('div', { class: 'checks' },
      r.ports.map((p) => h('div', { class: 'check-line' },
        h('span', { class: p.open ? 'ok-text' : 'bad-text' }, p.open ? '✓' : '✗'),
        h('div', {}, h('b', {}, `Port ${p.port}: ${p.open ? 'open' : 'closed'}`), h('div', { class: 'muted small' }, p.purpose),
          p.listening === false ? h('div', { class: 'muted small' }, `Couldn't test it: ${p.error}. Close whatever is using it.`) : null))),
      closed.length
        ? h('div', { class: 'callout' }, h('b', {}, 'To open them:'),
          h('ol', { class: 'tight' },
            h('li', {}, `On your router (usually http://192.168.1.1 or 10.0.0.1), forward TCP ${closed.map((p) => p.port).join(' and ')} to ${lan}.`),
            h('li', {}, 'When Windows Firewall asks about RetroConnect or RetroArch, click Allow.'),
            h('li', {}, 'Some internet providers share one address between customers (CGNAT); then forwarding can\'t work. Use Tailscale instead.')))
        : h('div', { class: 'ok-text small' }, `Your buddy can reach you at ${r.publicIp}.`),
      h('div', { class: 'muted small' }, `Checked ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} for ${r.publicIp}`));
  }
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, 'Are my ports open?'),
      h('button', { class: 'btn', disabled: Boolean(r && r.running), onclick: () => act(() => rc.checkPorts()) },
        r && r.at ? 'Check again' : 'Check my ports')),
    h('div', { style: 'margin-top:10px' }, body));
}

function compatNotes() {
  const c = S.compat;
  if (!c || !c.warnings.length) return null;
  return h('div', { class: 'compat' }, c.warnings.map((w) => h('div', { class: 'warn-text small' }, `⚠ ${w.text} `,
    w.fix && w.fix.action === 'match-retroarch' ? h('button', {
      class: 'btn small', disabled: Boolean(S.busy),
      onclick: () => act(() => rc.installRetroArch(w.fix.version), { success: `RetroArch ${w.fix.version} installed. Now hit Join.` }),
    }, `Match their RetroArch (${w.fix.version})`) : null)));
}

function connectionCheckCard() {
  const r = S.connCheck;
  const b = S.buddy || {};
  const who = b.nickname || 'your buddy';
  const online = b.status === 'online';
  const fixHint = (dir) => {
    if (S.config.connectionMode === 'tailscale') return 'Check Tailscale is connected on both PCs and that Windows Firewall allows RetroArch.';
    return dir === 'from'
      ? `Forward TCP ${S.config.netplayPort} to this PC on your router, and allow RetroArch in Windows Firewall. Or switch to Tailscale.`
      : `${who} needs to forward TCP ${S.config.netplayPort} to their PC and allow RetroArch in Windows Firewall. Or you both switch to Tailscale.`;
  };
  const line = (ok, title, detail) => h('div', { class: 'check-line' },
    h('span', { class: ok ? 'ok-text' : 'bad-text' }, ok ? '✓' : '✗'),
    h('div', {}, h('b', {}, title), detail ? h('div', { class: 'muted small' }, detail) : null));
  let body = h('p', { class: 'muted small', style: 'margin:0' }, `Measures the lag to ${who} and tests both directions of the netplay port (${S.config.netplayPort}), so you know a game will connect before you start one.`);
  if (r && r.running) body = h('div', { class: 'pad-waiting', style: 'margin:0' }, h('span', { class: 'pulse' }), 'Checking… (about 5 seconds)');
  else if (r && r.error) body = h('div', { class: 'bad-text' }, r.error);
  else if (r && r.ping) {
    const p = r.ping;
    body = h('div', { class: 'checks' },
      h('div', { class: 'check-line' }, h('span', { class: `ping ${p.quality}` }, `${p.median} ms`),
        h('div', {}, h('b', {}, `Lag: ${{ great: 'great', good: 'good', ok: 'playable', poor: 'high, expect some stutter' }[p.quality]}`),
          h('div', { class: 'muted small' }, `round trip, varies by ${p.jitter} ms`))),
      r.relay
        ? h('div', { class: 'muted small' }, 'Relay mode: gameplay goes through libretro\'s relay server, so no ports need to be open.')
        : [
          line(r.toBuddy.reachable, `You can join ${who}'s games`, r.toBuddy.reachable ? null : `${r.toBuddy.error}. ${fixHint('to')}`),
          line(r.fromBuddy.reachable, `${who} can join your games`, r.fromBuddy.reachable ? null : `${r.fromBuddy.error}. ${fixHint('from')}`),
          h('div', { class: 'muted small' }, 'RetroArch itself asks Windows Firewall for permission the first time it hosts. Click Allow.'),
        ],
      h('div', { class: 'muted small' }, `Lag smoothing: ${lagText(S.lag)}`),
      h('div', { class: 'muted small' }, `Checked ${new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
  }
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('div', { class: 'row' }, h('h2', { style: 'margin:0;flex:1' }, 'Connection check'),
      h('button', { class: 'btn', disabled: !online || (r && r.running) || Boolean(S.hosting || S.playing), onclick: () => act(() => rc.checkConnection()) },
        r && r.at ? 'Check again' : 'Check connection')),
    h('div', { style: 'margin-top:10px' }, online ? body : h('p', { class: 'muted small', style: 'margin:0' }, `Connect to ${who} first.`)));
}

function discordCard() {
  const cfg = S.config;
  const input = h('input', { type: 'text', value: cfg.discordUrl, placeholder: 'https://discord.gg/abc123' });
  const b = S.buddy || {};
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', {}, 'Discord'),
    h('p', { class: 'muted small', style: 'margin-top:0' },
      'Paste an invite (discord.gg/…) or a channel link for the Discord you both use. It shows up as an "Open Discord" button for both of you, so you can jump into voice when a game starts.'),
    h('div', { class: 'row' }, input,
      h('button', { class: 'btn primary', onclick: () => act(() => rc.saveSettings({ discordUrl: input.value }), { success: input.value ? 'Discord link saved' : 'Discord link removed' }) }, 'Save'),
      S.discord ? discordButton('btn') : null),
    !cfg.discordUrl && b.discordUrl ? h('div', { class: 'hint small muted', style: 'margin-top:8px' }, `Using ${b.nickname}'s link: ${b.discordUrl}`) : null);
}

function renderSettings() {
  if (!draft) draft = JSON.parse(JSON.stringify(S.config));
  const d = draft;
  const bind = (key, transform = (v) => v) => (e) => { d[key] = transform(e.target.type === 'checkbox' ? e.target.checked : e.target.value); };
  const browse = (key, title) => h('button', {
    class: 'btn', type: 'button',
    onclick: async () => {
      const p = await act(() => rc.pickFolder(title, d[key] || undefined));
      if (p) { d[key] = p; renderSettings(); }
    },
  }, 'Browse…');
  const raText = d.retroarchCommand.join(' ');
  const coreRows = Object.entries(d.coreMap).sort(([a], [b]) => a.localeCompare(b));
  const installed = new Set((lib ? lib.cores : []).map((c) => c.name));

  mount($('#view-settings'),
    h('div', { class: 'view-head' }, h('h1', {}, 'Settings')),
    h('div', { class: 'grid-2' },
      h('div', { class: 'card' },
        h('h2', {}, 'You'),
        h('div', { class: 'field' }, h('label', {}, 'Nickname'),
          h('input', { type: 'text', value: d.nickname, oninput: bind('nickname') })),
        h('div', { class: 'field' }, h('label', {}, 'ROM folder'),
          h('div', { class: 'row' }, h('input', { type: 'text', value: d.romsDir, oninput: bind('romsDir') }), browse('romsDir', 'Choose your ROM folder')),
          h('div', { class: 'hint' }, 'Games from your buddy are saved here too.')),
        h('div', { class: 'field' }, h('label', {}, 'RetroArch'),
          h('div', { class: 'row' },
            h('input', { type: 'text', value: raText, placeholder: `Auto: ${S.retroarch.command.join(' ') || 'not found'}`, oninput: (e) => { d.retroarchCommand = e.target.value.trim() ? [e.target.value.trim()] : []; } }),
            h('button', {
              class: 'btn', type: 'button',
              onclick: async () => { const p = await act(() => rc.pickFile('Find RetroArch')); if (p) { d.retroarchCommand = [p]; renderSettings(); } },
            }, 'Browse…')),
          h('div', { class: 'hint' }, S.retroarch.version ? `Using RetroArch ${S.retroarch.version}. Leave blank to auto-detect.` : 'Leave blank to auto-detect.'),
          retroarchInstaller()),
        h('div', { class: 'field' }, h('label', {}, 'Cores folder'),
          h('div', { class: 'row' }, h('input', { type: 'text', value: d.coresDir, placeholder: `Auto: ${S.coresDir}`, oninput: bind('coresDir') }), browse('coresDir', "Choose RetroArch's cores folder")))),
      h('div', { class: 'card' },
        h('h2', {}, 'Network'),
        h('div', { class: 'field' }, h('div', { class: 'label' }, 'Connection'),
          modePicker(d.connectionMode, (m) => { d.connectionMode = m; renderSettings(); })),
        d.connectionMode === 'relay' ? h('div', { class: 'field' }, h('label', {}, 'Relay server'),
          h('select', { onchange: bind('relayServer') },
            ['nyc', 'madrid', 'saopaulo', 'singapore'].map((r) => h('option', { value: r, selected: d.relayServer === r }, r)))) : null,
        h('div', { class: 'row' },
          h('div', { class: 'field', style: 'flex:1' }, h('label', {}, 'Netplay port'),
            h('input', { type: 'number', value: d.netplayPort, oninput: bind('netplayPort', Number) })),
          h('div', { class: 'field', style: 'flex:1' }, h('label', {}, 'Sync port'),
            h('input', { type: 'number', value: d.syncPort, oninput: bind('syncPort', Number) }))),
        lagField(d),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.retroEffects, onchange: bind('retroEffects') }),
          h('div', {}, h('div', {}, h('b', {}, 'Retro effects')),
            h('div', { class: 'muted small' }, 'Moving neon grid and CRT scanlines. Turn off for a still background (also off if Windows has animations turned off).'))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.showBoxArt, onchange: bind('showBoxArt') }),
          h('div', {}, h('div', {}, h('b', {}, 'Show box art')),
            h('div', { class: 'muted small' }, 'Covers come from libretro\'s thumbnail server (the one RetroArch uses), looked up by game name, and are stored on this PC.'))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.shareSaves, onchange: bind('shareSaves') }),
          h('div', {}, h('div', {}, h('b', {}, 'Share game saves')),
            h('div', { class: 'muted small' }, `When you host, RetroConnect grabs ${buddyName()}'s save for that game if it's newer, so co-op progress carries over. Yours is kept as a backup.`))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.shareLibrary, onchange: bind('shareLibrary') }),
          h('div', {}, h('div', {}, h('b', {}, 'Share my library while the app is open')),
            h('div', { class: 'muted small' }, 'Lets your buddy see your games and download them. When off, sharing only happens while you host.'))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.buildbotFallback, onchange: bind('buildbotFallback') }),
          h('div', {}, h('div', {}, h('b', {}, 'Download cores from libretro when we\'re on different systems')),
            h('div', { class: 'muted small' }, 'A Windows core can\'t run on a Mac (and so on), so the same core is fetched from the official libretro buildbot.'))))),
    updatesCard(d),
    h('div', { class: 'card', style: 'margin-top:16px' },
      h('h2', {}, 'Cores'),
      h('p', { class: 'muted small', style: 'margin-top:0' }, 'Which core runs each file type. Both players should use the same one. Installed cores are listed in green.'),
      h('table', { class: 'cores' }, h('tbody', {}, coreRows.map(([ext, core]) => h('tr', {},
        h('td', {}, `.${ext}`),
        h('td', {}, h('input', {
          type: 'text', value: core, style: installed.has(core) ? 'color:var(--ok)' : '',
          oninput: (e) => { d.coreMap[ext] = e.target.value.trim(); },
        }))))))),
    h('div', { class: 'save-bar' },
      h('button', {
        class: 'btn primary',
        onclick: () => act(async () => {
          for (const [k, v] of Object.entries(d.coreMap)) if (!v) delete d.coreMap[k];
          await rc.saveSettings(d);
          draft = null;
          await loadLibrary();
        }, { success: 'Settings saved' }),
      }, 'Save settings'),
      h('button', { class: 'btn', onclick: () => { draft = null; renderSettings(); } }, 'Discard changes')));
}

function lagText(lag) {
  if (!lag || lag.frames === null) return 'Connect to your buddy and it adjusts automatically.';
  const f = lag.frames === 0 ? 'no delay' : `${lag.frames} frame${lag.frames === 1 ? '' : 's'} of delay`;
  return lag.auto ? `Right now: ${f}${lag.ping !== null ? ` (ping ${lag.ping} ms)` : ''}.` : `Fixed: ${f}.`;
}

function lagField(d) {
  return h('div', { class: 'field' }, h('label', {}, 'Lag smoothing'),
    h('select', { onchange: (e) => { d.lagFrames = Number(e.target.value); } },
      h('option', { value: '-1', selected: d.lagFrames === -1 }, 'Automatic (recommended)'),
      h('option', { value: '0', selected: d.lagFrames === 0 }, 'Off'),
      [1, 2, 3, 4, 5, 6].map((n) => h('option', { value: String(n), selected: d.lagFrames === n }, `${n} frame${n === 1 ? '' : 's'}`))),
    h('div', { class: 'hint' }, 'Adds a tiny input delay so online games stutter less. Automatic picks it from your ping. ', lagText(S.lag)));
}

function updatesCard(d) {
  const u = S.update;
  let status = null;
  if (!S.updateFeed && !d.updateFeedUrl) status = h('span', { class: 'muted' }, 'Not set up yet. Paste the update link from whoever publishes RetroConnect.');
  else if (u && u.checking) status = h('span', { class: 'muted' }, 'Checking…');
  else if (u && u.error) status = h('span', { style: 'color:var(--bad)' }, u.error);
  else if (u && u.available) status = h('span', {}, h('b', {}, `Version ${u.latest} is available. `), h('button', { class: 'link-btn', onclick: () => act(() => rc.openUrl(u.url)) }, 'Download'));
  else if (u && u.configured) status = h('span', { class: 'ok-text' }, `✓ You're up to date (checked ${new Date(u.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`);
  return h('div', { class: 'card', style: 'margin-top:16px' },
    h('h2', {}, 'App updates'),
    h('div', { class: 'row', style: 'flex-wrap:wrap' },
      h('span', {}, `RetroConnect ${S.version}`),
      h('button', { class: 'btn small', disabled: !S.updateFeed || (u && u.checking), onclick: () => act(() => rc.checkForUpdates()) }, 'Check for updates'),
      status),
    h('div', { class: 'field', style: 'margin-top:12px;margin-bottom:0' }, h('label', {}, 'Update link'),
      h('input', { type: 'text', value: d.updateFeedUrl, placeholder: S.updateFeed && !d.updateFeedUrl ? `Built in: ${S.updateFeed}` : 'https://gist.githubusercontent.com/…/raw/retroconnect.json', oninput: (e) => { d.updateFeedUrl = e.target.value.trim(); } }),
      h('div', { class: 'hint' }, 'A public file that says which version is newest and where to download it. Save settings after changing it.')));
}

// ----- RetroArch setup page --------------------------------------------------

let raInfo = null;
let raInfoLoading = false;
const raOpts = { fullscreen: true, stickAsDpad: true, startSelectMenu: true };
let raCores = null; // Set of selected core names
let padLoop = null;
let padKey = null;

async function loadRaInfo() {
  if (raInfoLoading) return;
  raInfoLoading = true;
  try {
    raInfo = await rc.raSetupInfo();
    if (!raCores) raCores = new Set(raInfo.systems.filter((x) => x.netplay !== 'poor').map((x) => x.core));
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    raInfoLoading = false;
    if (view === 'retroarch') renderRetroArch();
  }
}

function readPads() {
  return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter(Boolean);
}

/** Tell the app which controllers are connected; it picks the RetroArch driver and profiles. */
function refreshPads() {
  const live = readPads();
  const key = live.map((g) => `${g.index}:${g.id}`).join('|');
  if (key === padKey) return;
  padKey = key;
  rc.reportPads(live.map((g) => ({ index: g.index, id: g.id, mapping: g.mapping }))).catch(() => {});
}

function startPadLoop() {
  if (padLoop) return;
  const tick = () => {
    if (view !== 'retroarch') { padLoop = null; return; }
    refreshPads();
    // Light up buttons without re-rendering the page.
    for (const g of readPads()) {
      const row = document.querySelector(`[data-pad="${g.index}"]`);
      if (!row) continue;
      g.buttons.forEach((b, i) => { const dot = row.children[i]; if (dot) dot.classList.toggle('on', b.pressed || b.value > 0.5); });
    }
    padLoop = requestAnimationFrame(tick);
  };
  padLoop = requestAnimationFrame(tick);
}

const PROFILE_TEXT = {
  builtin: (p) => h('div', { class: 'ok-text small' }, `✓ RetroArch has a profile for this controller (${p.profile.file}), so every button is mapped.`),
  created: (p) => h('div', { class: 'ok-text small' }, `✓ RetroConnect created a profile for this controller (${p.profile.file}), so every button is mapped.`),
  missing: (p) => h('div', { class: 'warn-text small' }, `⚠ ${p.profile.help}`),
  unknown: () => h('div', { class: 'muted small' }, 'Install RetroArch to check this controller.'),
};

function controllerCard() {
  const ctrl = S.controllers;
  const list = ctrl ? ctrl.pads : [];
  if (!list.length) return h('div', { class: 'pad-waiting' }, h('span', { class: 'pulse' }), 'Waiting for a controller… press any button on it.');
  const playerSelect = (p) => (p.vid
    ? h('label', { class: 'pad-assign' }, 'Local player',
      h('select', { onchange: (e) => act(() => rc.assignPad(p.key, e.target.value ? Number(e.target.value) : null)) },
        h('option', { value: '', selected: !ctrl.assign[p.key] }, 'Auto'),
        [1, 2, 3, 4].map((n) => h('option', { value: String(n), selected: ctrl.assign[p.key] === n }, `Player ${n}`))))
    : h('span', { class: 'muted small' }, 'Xbox-style controllers take player numbers in the order they connect.'));
  return h('div', { class: 'pads' },
    ctrl.live ? null : h('div', { class: 'muted small' }, 'These are the controllers from last time. Press a button to check they\'re still connected.'),
    h('div', { class: 'callout info', style: 'margin-top:0' },
      `RetroArch will use its "${ctrl.driver}" controller driver for ${list.length === 1 ? 'this controller' : 'these controllers'}. `,
      'RetroConnect sets this automatically every time you host or join, so plugging in a different controller just works.'),
    list.map((p) => h('div', { class: 'pad' },
      h('div', { class: 'row', style: 'flex-wrap:wrap' },
        h('b', {}, p.name),
        h('span', { class: 'badge both' }, p.label),
        h('span', { class: 'grow' }),
        playerSelect(p)),
      p.index !== undefined && ctrl.live ? h('div', { class: 'pad-buttons', 'data-pad': p.index }, Array.from({ length: 17 }, () => h('span', { class: 'pad-dot' }))) : null,
      (PROFILE_TEXT[p.profile.status] || PROFILE_TEXT.unknown)(p))),
    list.length > 1 ? h('div', { class: 'muted small' },
      'Online, each of you only needs your own controller: it plays as whichever player you are in the game. "Local player" matters when several people play on this PC.') : null);
}

function renderRetroArch() {
  const root = $('#view-retroarch');
  if (!raInfo) { loadRaInfo(); mount(root, h('div', { class: 'view-head' }, h('h1', {}, 'Set up RetroArch')), h('div', { class: 'empty' }, 'Loading…')); return; }
  startPadLoop();
  const haveRA = S.retroarch.command.length > 0;
  const busy = Boolean(S.busy) || Boolean(S.hosting || S.playing);
  const settingsFor = () => ({ ...raOpts });
  const toggle = (key, title, desc) => h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: raOpts[key], onchange: (e) => { raOpts[key] = e.target.checked; } }),
    h('div', {}, h('div', {}, h('b', {}, title)), h('div', { class: 'muted small' }, desc)));

  mount(root,
    h('div', { class: 'view-head' },
      h('h1', {}, 'Set up RetroArch'),
      h('button', { class: 'btn', disabled: !haveRA || busy, onclick: () => act(() => rc.raOpen(), { success: 'Opening RetroArch. Your controller should say "configured" in the corner.' }) }, 'Test RetroArch'),
      h('button', {
        class: 'btn primary', disabled: busy,
        onclick: () => act(async () => { raInfo = await rc.raSetupAll({ cores: [...raCores], settings: settingsFor() }); renderRetroArch(); await loadLibrary(); },
          { success: 'All set! Click Test RetroArch to try it.' }),
      }, S.busy ? `${S.busy}…` : 'Set it all up for me')),
    h('p', { class: 'muted', style: 'margin-top:-6px' }, 'One button does everything below: installs RetroArch if needed, the cores you tick, and the right settings for your controller.'),

    h('div', { class: 'card' },
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '1'), h('div', {}, h('b', {}, 'RetroArch'),
        h('div', { class: 'muted small' }, haveRA ? `Installed${S.retroarch.version ? ` (${S.retroarch.version})` : ''}` : 'Not installed yet'))),
      retroarchInstaller({ compact: true })),

    h('div', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '2'), h('div', {}, h('b', {}, 'Your controller'),
        h('div', { class: 'muted small' }, 'Plug it in (or pair it) and press any button while this window is open. Buttons light up when they work.'))),
      controllerCard()),


    h('div', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '3'), h('div', {}, h('b', {}, 'Systems you play'),
        h('div', { class: 'muted small' }, 'Each system needs a "core" (its emulator). Ticked ones get installed.'))),
      h('div', { class: 'systems' }, raInfo.systems.map((x) => h('label', { class: 'toggle sys-row' },
        h('input', {
          type: 'checkbox', checked: x.installed || raCores.has(x.core), disabled: x.installed,
          onchange: (e) => { if (e.target.checked) raCores.add(x.core); else raCores.delete(x.core); },
        }),
        h('div', { class: 'grow' }, h('b', {}, x.label),
          x.netplay === 'poor' ? h('span', { class: 'muted small' }, ' · often laggy online') : null),
        x.installed ? h('span', { class: 'ok-text' }, '✓ Installed') : null))),
      h('button', {
        class: 'btn', disabled: busy || !haveRA, style: 'margin-top:10px',
        onclick: () => act(async () => { await rc.raSetupCores([...raCores]); raInfo = null; await loadRaInfo(); await loadLibrary(); }, { success: 'Cores installed' }),
      }, 'Install ticked cores')),

    h('div', { class: 'card', style: 'margin-top:16px' },
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '4'), h('div', {}, h('b', {}, 'Settings'),
        h('div', { class: 'muted small' }, 'Sensible defaults for couch-style netplay. Close RetroArch before applying.'))),
      h('div', { class: 'toggle static' }, h('span', { class: 'ok-text' }, '✓'),
        h('div', {}, h('div', {}, h('b', {}, 'Keep playing when RetroArch isn\'t the active window')),
          h('div', { class: 'muted small' }, 'Always on. Otherwise checking Discord would freeze the game for both of you.'))),
      toggle('startSelectMenu', 'Open the RetroArch menu with Start + Select', 'So you never need a keyboard to get to the menu, save or quit.'),
      toggle('stickAsDpad', 'Left stick works like the D-pad', 'Retro games only know the D-pad. This lets you use the stick too.'),
      toggle('fullscreen', 'Start in fullscreen', 'Alt+Enter switches back to a window.'),
      h('div', { class: 'row', style: 'margin-top:6px;flex-wrap:wrap' },
        h('button', {
          class: 'btn', disabled: busy || !haveRA,
          onclick: () => act(async () => { await rc.raSetupApply(settingsFor()); raInfo = null; await loadRaInfo(); }, { success: 'RetroArch settings saved' }),
        }, 'Apply settings'),
        h('span', { class: 'muted small mono' }, raInfo.configFile))));
}

// ----- RetroArch install button ---------------------------------------------

let raCheck = null;
function checkLatestRetroArch() {
  if (!raCheck) {
    raCheck = rc.retroarchLatest().catch((err) => {
      raCheck = null;
      addLog({ message: err.message, level: 'warn', at: Date.now() });
    });
  }
  return raCheck;
}

function retroarchInstaller({ compact = false } = {}) {
  const ra = S.retroarch;
  if (!ra.canInstall) return null;
  if (!ra.latest) {
    checkLatestRetroArch();
    return h('div', { class: 'ra-install muted small' }, 'Checking for the latest RetroArch…');
  }
  const installing = S.busy === 'Installing RetroArch';
  const have = ra.command.length > 0;
  const v = ra.latest.version;
  let label = null;
  if (!have) label = `Install RetroArch ${v}`;
  else if (ra.updateAvailable) label = ra.managed ? `Update RetroArch to ${v}` : `Install RetroArch ${v}`;

  if (!label && installing) {
    return h('div', { class: 'ra-install' },
      h('button', { class: 'btn', disabled: true }, 'Installing…'),
      h('span', { class: 'muted small' }, 'Watch the progress bar at the bottom.'));
  }
  if (!label) {
    return h('div', { class: 'ra-install' },
      h('span', { class: 'ok-text' }, `✓ You have the latest RetroArch (${v})`),
      compact ? null : h('button', {
        class: 'link-btn small', disabled: Boolean(S.busy),
        onclick: () => act(() => rc.installRetroArch(), { success: `RetroArch ${v} reinstalled` }),
      }, 'Reinstall'));
  }
  const note = [];
  if (ra.latest.size) note.push(`${fmtBytes(ra.latest.size)} download from libretro`);
  if (have && !ra.managed) note.push(`you have ${ra.version || 'an unknown version'}; this installs a separate up-to-date copy`);
  if (ra.managed) note.push('your settings, saves and cores are kept');
  return h('div', { class: 'ra-install' },
    h('button', {
      class: `btn ${have ? 'cyan' : 'primary'}`, disabled: Boolean(S.busy),
      onclick: () => act(() => rc.installRetroArch(), { success: (r) => `RetroArch ${r.version} installed` }),
    }, installing ? 'Installing…' : label),
    h('span', { class: 'muted small' }, installing ? 'Watch the progress bar at the bottom. This takes a minute or two.' : note.join(' · ')));
}

// ----- Tailscale panel --------------------------------------------------------

let tsCheck = null;
let tsKeyDraft = '';
let tsShowKey = false;

function tailscalePanel({ compact = false } = {}) {
  const ts = S.tailscale;
  const busyInstall = S.busy === 'Installing Tailscale';
  const link = (label, url) => h('button', { class: 'link-btn', onclick: () => act(() => rc.openUrl(url)) }, label);
  const box = (...kids) => h('div', { class: 'ts-panel' }, ...kids);

  if (!ts.installed) {
    if (!ts.canInstall) {
      return box(h('p', {}, 'Tailscale isn\'t installed. ', link('Download Tailscale', 'https://tailscale.com/download')));
    }
    if (!ts.latest && !tsCheck) tsCheck = rc.tsLatest().catch((err) => { tsCheck = null; addLog({ message: err.message, level: 'warn', at: Date.now() }); });
    const v = ts.latest && ts.latest.version ? ` ${ts.latest.version}` : '';
    return box(
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '1'),
        h('div', {}, h('b', {}, 'Install Tailscale'),
          h('div', { class: 'muted small' }, 'Free, about 40 MB. Windows asks for permission once. Click Yes.'))),
      h('div', { class: 'ra-install' },
        h('button', { class: 'btn primary', disabled: Boolean(S.busy), onclick: () => act(() => rc.tsInstall(), { success: 'Tailscale installed' }) },
          busyInstall ? 'Installing…' : `Install Tailscale${v}`)));
  }

  if (ts.state === 'NotRunning') {
    return box(h('p', {}, 'Tailscale is installed but not running.'),
      h('button', { class: 'btn primary', onclick: () => act(() => rc.tsStart()) }, 'Start Tailscale'));
  }

  if (ts.state !== 'Running') {
    if (ts.signingIn) {
      return box(
        h('div', { class: 'row' }, h('span', { class: 'pulse' }),
          h('b', {}, ts.authUrl ? 'Finish signing in in your browser…' : 'Connecting to Tailscale…')),
        ts.authUrl ? h('p', { class: 'muted small' }, 'Didn\'t see a browser window? ', link('Open the sign-in page', ts.authUrl)) : null,
        h('button', { class: 'btn small', onclick: () => act(() => rc.tsCancel()) }, 'Cancel'));
    }
    const keyInput = h('input', {
      type: 'text', class: 'secret', placeholder: 'tskey-auth-…', value: tsKeyDraft,
      oninput: (e) => { tsKeyDraft = e.target.value.trim(); },
    });
    return box(
      h('div', { class: 'ts-step' }, h('span', { class: 'step-num' }, '2'),
        h('div', {}, h('b', {}, 'Connect this PC to Tailscale'),
          h('div', { class: 'muted small' }, 'One of you needs a free Tailscale account. The other can join with a key, no account needed.'))),
      h('div', { class: 'choice' },
        h('button', { class: 'mode', onclick: () => act(() => rc.tsLogin(), { success: 'Connected to Tailscale' }) },
          h('strong', {}, 'Sign in'), h('span', {}, 'Opens your browser. Use Google, Microsoft, GitHub or Apple to sign in or create a free account.')),
        h('button', { class: `mode ${tsShowKey ? 'active' : ''}`, onclick: () => { tsShowKey = true; render(); } },
          h('strong', {}, 'My buddy sent me a key'), h('span', {}, 'Join their Tailscale network without making an account.'))),
      tsShowKey ? h('div', { class: 'row' }, keyInput,
        h('button', {
          class: 'btn primary',
          onclick: () => act(async () => { await rc.tsLogin(keyInput.value.trim()); tsKeyDraft = ''; tsShowKey = false; }, { success: 'Joined your buddy\'s Tailscale network' }),
        }, 'Join')) : null);
  }

  // Connected
  const me = ts.self || {};
  const peers = ts.peers || [];
  const current = S.config.peerAddress;
  return box(
    h('div', { class: 'row' }, h('span', { class: 'ok-text' }, `✓ On Tailscale as ${me.name || 'this PC'}`),
      me.ip ? h('span', { class: 'mono muted' }, me.ip) : null,
      me.ip ? h('button', { class: 'link-btn small', onclick: () => act(() => rc.copy(me.ip), { success: 'Copied' }) }, 'Copy') : null),
    h('div', { class: 'label', style: 'margin-top:12px;font-weight:650;font-size:13px' }, 'Which one is your buddy?'),
    peers.length
      ? h('div', { class: 'peers' }, peers.map((p) => h('div', { class: `peer ${p.ip === current ? 'chosen' : ''}` },
        h('span', { class: `dot ${p.online ? 'online' : ''}` }),
        h('div', { class: 'grow' }, h('div', {}, h('b', {}, p.name), h('span', { class: 'muted small' }, `  ${p.os || ''}${p.online ? '' : ' · offline'}`)),
          h('div', { class: 'mono muted' }, p.ip)),
        p.ip === current
          ? h('span', { class: 'ok-text' }, '✓ Your buddy')
          : h('button', { class: 'btn small', onclick: () => act(() => rc.tsUsePeer(p.ip), { success: `${p.name} is your buddy` }) }, 'This is my buddy'))))
      : h('div', { class: 'callout' }, 'Your buddy isn\'t on your Tailscale network yet.'),
    compact ? null : h('details', { class: 'ts-help', open: !peers.length || null },
      h('summary', {}, 'How to add your buddy'),
      h('ol', { class: 'tight' },
        h('li', {}, 'Easiest: ', link('create a key', ts.keysPage),
          ' (click Generate auth key; leave Reusable off), copy it, and send it to your buddy privately. In RetroConnect they choose ', h('b', {}, 'My buddy sent me a key'), ' and paste it.'),
        h('li', {}, 'Or, if they already have their own Tailscale account, share this PC with them from the ', link('Machines page', ts.machinesPage), ' (… menu → Share).'))));
}

// ----- first-run wizard ------------------------------------------------------

const wiz = { step: 0, data: null, role: null };

function renderWizard() {
  const box = $('#wizard');
  if (S.configured) { box.hidden = true; return; }
  box.hidden = false;
  if (!wiz.data) wiz.data = JSON.parse(JSON.stringify(S.config));
  const d = wiz.data;
  const steps = 3;
  const next = () => { wiz.step++; renderWizard(); };
  const back = () => { wiz.step--; renderWizard(); };
  let body;

  if (wiz.step === 0) {
    body = [
      h('h1', {}, 'Welcome to RetroConnect'),
      h('p', { class: 'muted' }, 'Play RetroArch netplay with a friend. Whoever hosts, the other gets the exact same core and ROM automatically.'),
      h('div', { class: 'field' }, h('label', {}, 'Your nickname'),
        h('input', { type: 'text', value: d.nickname, oninput: (e) => { d.nickname = e.target.value; } })),
      h('div', { class: 'field' }, h('label', {}, 'ROM folder'),
        h('div', { class: 'row' }, h('input', { type: 'text', value: d.romsDir, oninput: (e) => { d.romsDir = e.target.value; } }),
          h('button', { class: 'btn', onclick: async () => { const p = await act(() => rc.pickFolder('Choose your ROM folder', d.romsDir)); if (p) { d.romsDir = p; renderWizard(); } } }, 'Browse…')),
        h('div', { class: 'hint' }, "Where your games are, or where your buddy's games should go. It's created if it doesn't exist.")),
    ];
  } else if (wiz.step === 1) {
    const found = S.retroarch.command.length;
    body = [
      h('h1', {}, 'RetroArch'),
      found
        ? h('div', { class: 'callout info' }, `Found RetroArch${S.retroarch.version ? ' ' + S.retroarch.version : ''}: `, h('span', { class: 'mono' }, S.retroarch.command.join(' ')))
        : h('div', { class: 'callout' }, S.retroarch.canInstall
          ? "RetroArch isn't installed yet. Install it with one click, or point to an existing copy below."
          : "Couldn't find RetroArch automatically. Install it from retroarch.com, or point to it below."),
      retroarchInstaller({ compact: true }),
      h('div', { class: 'field', style: 'margin-top:14px' }, h('label', {}, found ? 'Use a different RetroArch (optional)' : 'RetroArch location'),
        h('div', { class: 'row' },
          h('input', { type: 'text', value: d.retroarchCommand.join(' '), oninput: (e) => { d.retroarchCommand = e.target.value.trim() ? [e.target.value.trim()] : []; } }),
          h('button', { class: 'btn', onclick: async () => { const p = await act(() => rc.pickFile('Find RetroArch')); if (p) { d.retroarchCommand = [p]; renderWizard(); } } }, 'Browse…'))),
      h('p', { class: 'muted small' }, `Cores folder: ${d.coresDir || S.coresDir} (change it later in Settings).`),
      found || S.retroarch.canInstall ? null : h('button', { class: 'link-btn', onclick: () => act(() => rc.openUrl('https://www.retroarch.com/?page=platforms')) }, 'Download RetroArch'),
    ];
  } else {
    body = [
      h('h1', {}, 'Pair with your buddy'),
      h('p', { class: 'muted' }, 'You both need the same shared secret. One of you creates it and sends it to the other.'),
      h('div', { class: 'choice' },
        h('button', {
          class: `mode ${wiz.role === 'create' ? 'active' : ''}`,
          onclick: async () => { wiz.role = 'create'; d.sharedSecret = await rc.newSecret(); renderWizard(); },
        }, h('strong', {}, "I'm first"), h('span', {}, 'Create a secret to send')),
        h('button', {
          class: `mode ${wiz.role === 'paste' ? 'active' : ''}`,
          onclick: () => { wiz.role = 'paste'; d.sharedSecret = ''; renderWizard(); },
        }, h('strong', {}, 'My buddy sent me one'), h('span', {}, 'Paste their secret'))),
      wiz.role === 'create' ? h('div', { class: 'field' }, h('label', {}, 'Your shared secret'),
        h('div', { class: 'row' }, h('input', { type: 'text', value: d.sharedSecret, readonly: true, class: 'secret' }),
          h('button', { class: 'btn', onclick: () => act(() => rc.copy(d.sharedSecret), { success: 'Copied. Send it to your buddy.' }) }, 'Copy'))) : null,
      wiz.role === 'paste' ? h('div', { class: 'field' }, h('label', {}, 'Shared secret from your buddy'),
        h('input', { type: 'text', class: 'secret', value: d.sharedSecret, oninput: (e) => { d.sharedSecret = e.target.value.trim(); } })) : null,
      h('div', { class: 'field' }, h('div', { class: 'label' }, 'How will you connect?'),
        modePicker(d.connectionMode, (m) => { d.connectionMode = m; renderWizard(); })),
      d.connectionMode === 'tailscale' ? tailscalePanel({ compact: true }) : null,
      h('div', { class: 'field' }, h('label', {}, "Buddy's address (optional; add it later on the Connect page)"),
        h('input', { type: 'text', value: d.peerAddress, placeholder: 'e.g. 100.101.102.103', oninput: (e) => { d.peerAddress = e.target.value; } })),
    ];
  }

  const last = wiz.step === steps - 1;
  mount(box, h('div', { class: 'wizard-box' },
    h('div', { class: 'steps' }, Array.from({ length: steps }, (_, i) => h('span', { class: i <= wiz.step ? 'done' : '' }))),
    body,
    h('div', { class: 'wizard-actions' },
      wiz.step ? h('button', { class: 'btn', onclick: back }, 'Back') : h('span'),
      last
        ? h('button', {
          class: 'btn primary', disabled: !d.sharedSecret,
          onclick: () => act(async () => { await rc.saveSettings(d); wiz.data = null; await loadLibrary(); }, { success: "You're all set!" }),
        }, 'Finish')
        : h('button', { class: 'btn primary', disabled: wiz.step === 0 && !(d.nickname.trim() && d.romsDir.trim()), onclick: next }, 'Next'))));
}

// ----- data loading ----------------------------------------------------------

async function loadLibrary(refreshBuddy = false) {
  lib = await rc.library({ refreshBuddy });
  if (S) renderBanner(); // e.g. a suggestion banner changes from "Get it" to "Host it"
  if (view === 'games') renderGames();
}

let lastBuddyKey = '';
async function boot() {
  document.querySelectorAll('.nav-item').forEach((b) => b.addEventListener('click', () => {
    view = b.dataset.view;
    if (view !== 'settings') draft = null;
    render();
  }));
  $('#buddy-card').addEventListener('click', () => { view = 'buddy'; render(); });
  $('#activity-toggle').addEventListener('click', () => { const l = $('#log'); l.hidden = !l.hidden; });

  rc.onState((s) => {
    const prev = S;
    S = s;
    document.body.classList.toggle('no-fx', s.config.retroEffects === false);
    // Reload the merged game list when the buddy comes online / goes away.
    const key = `${s.buddy.status}:${s.buddy.romCount || 0}:${s.config.romsDir}`;
    if (key !== lastBuddyKey) { lastBuddyKey = key; loadLibrary().catch(() => {}); }
    // Something changed settings behind an open form (Install RetroArch, picking a Tailscale buddy):
    // carry it into the drafts so saving them doesn't undo it.
    for (const key of ['retroarchCommand', 'peerAddress', 'connectionMode']) {
      if (prev && JSON.stringify(prev.config[key]) !== JSON.stringify(s.config[key])) {
        const v = JSON.parse(JSON.stringify(s.config[key]));
        if (draft) draft[key] = v;
        if (wiz.data) wiz.data[key] = v;
        if (key === 'retroarchCommand') { raInfo = null; }
      }
    }
    // Don't rebuild a form while someone is typing in it.
    const typing = document.activeElement && document.activeElement.matches('input[type=text], input[type=search], input[type=number], textarea, select')
      && document.activeElement.closest('.main, #wizard');
    if (typing) { renderBuddyCard(); renderBanner(); return; }
    render();
  });
  rc.onLog(addLog);
  rc.onProgress(showProgress);
  rc.onInvite((s) => toast(`${s.host_nickname} is hosting ${gameTitle(s.rom.path)}. Click Join!`));
  rc.onThumbs(() => loadLibrary().catch(() => {}));
  rc.onSuggestion((sug) => toast(`${sug.from} wants to play ${gameTitle(sug.rom.path)}`));
  // Always keep an eye on connected controllers (cheap), so Host/Join use the right setup.
  window.addEventListener('gamepadconnected', refreshPads);
  window.addEventListener('gamepaddisconnected', refreshPads);
  setInterval(refreshPads, 1000);

  S = await rc.state();
  render();
  if (S.server.error) addLog({ message: S.server.error, level: 'error', at: Date.now() });
  await loadLibrary().catch((err) => toast(err.message, 'error'));
}

boot();
