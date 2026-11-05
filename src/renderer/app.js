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

function gameTitle(p) {
  const base = p.split('/').pop();
  return base.replace(/\.[^.]+$/, '');
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
function showProgress({ label, done, total, percent }) {
  const box = $('#progress');
  const pct = total ? Math.min(100, (100 * done) / total) : 100;
  box.hidden = false;
  box.querySelector('.progress-fill').style.width = `${pct}%`;
  box.querySelector('.progress-label').textContent = percent
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
  for (const v of ['games', 'buddy', 'settings']) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'games') renderGames();
  if (view === 'buddy') renderConnect();
  if (view === 'settings') renderSettings();
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

function renderBanner() {
  const b = S.buddy || {};
  let node = null;
  if (S.hosting) {
    node = h('div', { class: 'banner hosting' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `You're hosting ${gameTitle(S.hosting.rom.path)}`),
        h('div', { class: 'muted small' },
          b.status === 'online'
            ? `${b.nickname} has been notified. Their app will download anything they're missing, then connect.`
            : `Waiting for your buddy to open RetroConnect and click Join.`)),
      h('button', { class: 'btn danger', onclick: () => act(() => rc.stopHosting()) }, 'Stop hosting'));
  } else if (S.playing) {
    node = h('div', { class: 'banner hosting' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `Playing ${gameTitle(S.playing.rom.path)} with ${S.playing.host}`),
        h('div', { class: 'muted small' }, 'Close RetroArch to end the session.')));
  } else if (b.status === 'online' && b.session) {
    const s = b.session;
    node = h('div', { class: 'banner' },
      h('span', { class: 'pulse' }),
      h('div', { class: 'grow' },
        h('div', { class: 'big' }, `${s.host_nickname} is hosting ${gameTitle(s.rom.path)}`),
        h('div', { class: 'muted small' },
          `${s.core.name.replace(/_libretro$/, '')} · ${fmtBytes(s.rom.size)}. Anything you're missing is downloaded first.`)),
      h('button', {
        class: 'btn primary', disabled: Boolean(S.busy),
        onclick: () => act(async () => { await rc.join(); await loadLibrary(); }, { success: 'Starting RetroArch…' }),
      }, S.busy ? S.busy + '…' : 'Join game'));
  }
  mount($('#banner'), node);
}

function filteredRows() {
  if (!lib) return [];
  const q = query.trim().toLowerCase();
  return lib.rows.filter((r) => {
    if (q && !r.path.toLowerCase().includes(q)) return false;
    if (filter === 'ready') return r.status === 'both';
    if (filter === 'download') return r.status === 'theirs' || r.status === 'different';
    if (filter === 'mine') return r.status === 'mine' || r.status === 'unknown';
    return true;
  });
}

function gameRow(r) {
  const canHost = r.mine && !S.hosting && !S.playing;
  const actions = [];
  if (r.mine) {
    actions.push(h('button', {
      class: 'btn small primary', disabled: !canHost || !r.coreInstalled,
      title: !r.coreInstalled
        ? (r.coreName ? `${r.coreName} isn't installed. Get it from RetroArch's Online Updater.` : 'No core set for this file type (Settings → Cores)')
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
  const core = r.coreName ? r.coreName.replace(/_libretro$/, '') : 'no core set';
  const entry = r.mine || r.theirs;
  return h('div', { class: 'game' },
    h('div', { class: 'sys' }, systemOf(r.path)),
    h('div', { style: 'min-width:0' },
      h('div', { class: 'title', title: r.path }, gameTitle(r.path)),
      h('div', { class: 'meta' }, `${r.path} · ${fmtBytes(entry.size)} · ${core}${r.mine && !r.coreInstalled && r.coreName ? ' (not installed)' : ''}`)),
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
  ];
  const search = h('input', {
    type: 'search', placeholder: 'Search games', value: query,
    oninput: (e) => { query = e.target.value; renderGameList(); },
  });
  mount(root,
    h('div', { class: 'view-head' },
      h('h1', {}, 'Games'),
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
  if (cfg.connectionMode === 'tailscale') {
    return h('div', { class: 'callout info' },
      'Install Tailscale on both PCs and sign in to the same account (or share the machine). Use your buddy\'s ',
      h('b', {}, '100.x.y.z'), ' address below. ',
      h('button', { class: 'link-btn', onclick: () => act(() => rc.openUrl('https://tailscale.com/download')) }, 'Get Tailscale'));
  }
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
        h('div', { class: 'hint small muted' }, 'Over the internet without Tailscale, give them your public IP instead (search "what is my IP").'),
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
          h('dt', {}, 'Your system'), h('dd', {}, S.platform)))));
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
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.shareLibrary, onchange: bind('shareLibrary') }),
          h('div', {}, h('div', {}, h('b', {}, 'Share my library while the app is open')),
            h('div', { class: 'muted small' }, 'Lets your buddy see your games and download them. When off, sharing only happens while you host.'))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: d.buildbotFallback, onchange: bind('buildbotFallback') }),
          h('div', {}, h('div', {}, h('b', {}, 'Download cores from libretro when we\'re on different systems')),
            h('div', { class: 'muted small' }, 'A Windows core can\'t run on a Mac (and so on), so the same core is fetched from the official libretro buildbot.'))))),
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
    // Reload the merged game list when the buddy comes online / goes away.
    const key = `${s.buddy.status}:${s.buddy.romCount || 0}:${s.config.romsDir}`;
    if (key !== lastBuddyKey) { lastBuddyKey = key; loadLibrary().catch(() => {}); }
    // Something changed RetroArch behind an open form (e.g. "Install RetroArch"):
    // carry it into the drafts so saving them doesn't undo it.
    if (prev && JSON.stringify(prev.config.retroarchCommand) !== JSON.stringify(s.config.retroarchCommand)) {
      if (draft) draft.retroarchCommand = [...s.config.retroarchCommand];
      if (wiz.data) wiz.data.retroarchCommand = [...s.config.retroarchCommand];
    }
    // Don't rebuild a form while someone is typing in it.
    const typing = document.activeElement && document.activeElement.matches('input, select')
      && document.activeElement.closest('#view-settings, #wizard');
    if (typing) { renderBuddyCard(); renderBanner(); return; }
    render();
  });
  rc.onLog(addLog);
  rc.onProgress(showProgress);
  rc.onInvite((s) => toast(`${s.host_nickname} is hosting ${gameTitle(s.rom.path)}. Click Join!`));

  S = await rc.state();
  render();
  if (S.server.error) addLog({ message: S.server.error, level: 'error', at: Date.now() });
  await loadLibrary().catch((err) => toast(err.message, 'error'));
}

boot();
