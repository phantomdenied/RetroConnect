# RetroConnect

A desktop app for playing RetroArch netplay with a friend. Whoever hosts, the
other player automatically gets the **exact same core and ROM**, sent straight
from the host, so there are no "content mismatch" errors or desyncs from
mismatched files. Then RetroArch launches and connects for both of you.

**What it does**

- **Games list** shows both libraries side by side: *Ready to play*, *Buddy has
  it*, *Different version*, *Only you*. One click gets a game from your buddy.
- **Host** a game and your buddy's app shows a **Join** banner and a
  desktop notification.
- **Join** checks the core and ROM by content hash, downloads anything missing
  or different (resumable, verified), and launches RetroArch connected to the
  host.
- Anything replaced is kept as `<file>.<timestamp>.old`, never deleted.
- **🎲 Pick a game for us** chooses something you both have. **Suggest** sends
  it to your buddy, whose app shows "Sam wants to play …" with **Host it**
  (or **Get it** if they don't have it yet).
- **<Friend>'s games** page: browse your friend's whole library and click
  **Ask to play** (they get a pop-up with **Host it**) or **Get it**.
- **Player 1 / Player 2**: choose who's Player 1 when you host (you or your
  friend). See *Players and controllers* below.
- **Box art and clean names**: covers from libretro's thumbnail server (the
  one RetroArch uses), and "The Legend of Zelda - A Link to the Past" instead
  of `Legend of Zelda, The - A Link to the Past (USA) [!].sfc`.
- **Right emulator for zipped games**: the core is picked from the system
  folder a game is in ("Nintendo - Super Nintendo Entertainment System", "SNES",
  "Genesis", ...), so zipped sets work; otherwise from the file extension.
  Settings → Cores still decides which core each system uses.
- **Filters**: system, language, official / ROM hacks / homebrew, single
  player / multiplayer and genre. Player counts and genres come from
  libretro's game database (the one RetroArch uses), downloaded once per
  system; system, language and hacks come from folder names and name tags.
- **⇄ Swap players** during a game: Player 1 and Player 2 trade places without
  restarting, for taking turns in single-player games. Either of you can press it.
- **★ Favorites and Recently played**: star games, see when you last played
  them and how often. "Pick a game for us" favors favorites and games you
  haven't played lately.
- **Connection check** (Connect page): ping to your buddy, and whether each of
  you can reach the other's netplay port, with fixes if not.
- **Your internet address and port check** (Connect page, Direct mode): the
  app shows your internet IP with a Copy button (no "what is my IP" site), and
  **Check my ports** tests 55440 and 55435 from outside (via portchecker.io)
  before your buddy even connects.
- **Version warnings**: the join banner warns when your RetroArch, core or
  RetroConnect versions differ, with a button to install the host's exact
  RetroArch version.
- **Lag smoothing**: a frame or two of input delay picked automatically from
  your ping, so online games stutter less (Settings, or set it by hand).
- **Shared saves**: when you host, RetroConnect grabs your buddy's battery save
  (`.srm`) for that game if it's newer, so co-op progress carries over. Yours is
  kept as a backup. Newer is judged by how long ago each save was written on
  its own PC, so a wrong clock doesn't cause trouble. Your buddy needs **Share
  my library** on, so your app can fetch from theirs.
- **Open Discord**: save your group's Discord invite or channel link once
  (Connect page) and both of you get a button for it.
- **RetroArch setup** page: one button installs RetroArch, the cores for the
  systems you tick, and controller-friendly settings (below).
- **Update notice** when a new RetroConnect version is published (below).

## Install (Windows)

Download from the [Releases page](https://github.com/phantomdenied/RetroConnect/releases):

- `RetroConnect-x.y.z-win-setup.exe`: normal installer (Start menu shortcut, uninstaller)
- `RetroConnect-x.y.z-win-portable.exe`: no install, just run it

The app isn't code-signed, so the first time Windows shows **"Windows protected
your PC"**. Click **More info → Run anyway**.

When you first open it, Windows Firewall asks whether RetroConnect may use the
network. Click **Allow** (private networks is enough with Tailscale or a home
network). RetroArch asks the same the first time you host.

### RetroArch

Don't have RetroArch? Click **Install RetroArch** in the setup wizard (or in
Settings). RetroConnect downloads the latest stable Windows build from
libretro (about 200 MB) and unpacks it into
`%LOCALAPPDATA%\RetroConnect\RetroArch`. It needs no admin rights and is set up
for you automatically. When a newer stable release comes out, the same button
becomes **Update RetroArch**. Your settings, saves and cores are kept. If you
both click it, you'll be on the same version, which netplay likes.

### RetroArch setup page (for people who never want to see RetroArch's menus)

Open the **RetroArch** page and press **Set it all up for me**. It:

1. Installs RetroArch if it's missing.
2. Installs a core (emulator) for each system you tick: NES, SNES, Genesis,
   Arcade, PC Engine, Game Boy, GBA and Atari are ticked by default. N64 isn't,
   because it's often laggy online.
3. Sets up your controller (see below).
4. Applies netplay-friendly settings:
   - The game keeps running when RetroArch isn't the active window.
     Otherwise alt-tabbing to Discord freezes it for both of you.
   - **Start + Select** opens the RetroArch menu, so you never need a keyboard.
   - The left stick works like the D-pad.
   - RetroArch starts in fullscreen.

**Test RetroArch** opens it so you can see the "controller configured" message.

### Players and controllers

**Your controller is read automatically.** RetroConnect watches for
controllers whenever its window is open (press any button once) and remembers
them. On every **Host** and **Join** it:

- picks the RetroArch controller driver that suits what's plugged in: `sdl2`
  for PlayStation/Nintendo pads, `xinput` when an Xbox-style pad is connected
  (that driver also handles other pads through DirectInput);
- checks RetroArch's controller profiles (its `autoconfig` folder) for each
  controller by its vendor/product ID, or as "XInput Controller" for Xbox-style
  pads. RetroArch ships hundreds, so this is usually a ✓;
- writes a profile for a standard PlayStation/Nintendo-style controller
  RetroArch doesn't know, using RetroArch's own standard layout;
- explains the one-time mapping for an unknown no-name pad
  (RetroArch → Settings → Input → Port 1 Controls → Set All Controls).

The RetroArch page shows all of this per controller, with a live button test.

**Who's Player 1 online?** Whoever hosts is Player 1 and the person joining is
Player 2, and each of you plays with your own controller whatever number you
are. To flip it, use **When I host, Player 1 is: me / <friend>** on the Games
page: the host then starts out watching, your friend joins as Player 1, and
the host steps in as Player 2. The join banner says "You'll be Player 1/2".

**Taking turns:** press **⇄ Swap players** in the game banner (either of you)
and Player 1 and 2 trade places a second later, game still running. Under the
hood both RetroArchs step out to watch (`NETPLAY_GAME_WATCH` over RetroArch's
local command port) and the new Player 1 steps back in first; RetroArch gives
the lowest free player number. That's also why RetroConnect no longer asks
RetroArch for fixed slots (`netplay_request_device_pN`): they would undo a
swap. Both of you need RetroConnect 0.7.1 or newer for swapping.

**Several controllers on one PC?** Set **Local player** next to each
controller on the RetroArch page. RetroConnect reserves that controller for
that player in RetroArch (`input_playerN_reserved_device`), so the right pad
is always Player 1 even if another one (or a virtual DS4Windows pad) connects
first. Xbox-style pads can't be reserved this way, because Windows doesn't
report which one is which; they take numbers in the order they connect.
Your original `retroarch.cfg` is saved once as
`retroarch.cfg.before-retroconnect`. Close RetroArch before applying settings,
because RetroArch rewrites its config when it quits.

Already have RetroArch? RetroConnect looks in the usual places
(`C:\RetroArch-Win64`, Steam, `%APPDATA%`); otherwise point to `retroarch.exe`
in Settings.

## First run

The setup wizard asks for:

1. **Your nickname and ROM folder.** Games your buddy sends go here too.
2. **RetroArch.** Usually detected automatically.
3. **Pairing.** One of you clicks *I'm first* and sends the generated secret
   to the other, who picks *My buddy sent me one* and pastes it.

Then, on the **Connect** page, enter each other's address.

## Connecting

Pick a mode on the **Connect** page:

| Mode | Setup |
|---|---|
| **Tailscale** (recommended) | Encrypted, and no router setup. RetroConnect installs and connects it for you (below). |
| **Direct** | Same Wi-Fi: use the LAN address shown on the Connect page. Over the internet: the host forwards TCP **55440** (file sync) and **55435** (netplay). File traffic is unencrypted in this mode. |
| **Relay** | Gameplay goes through a libretro relay server, and the guest joins from RetroArch's *Netplay → Refresh Host List*. Downloading games still needs port 55440 reachable, so pair it with Tailscale or a port forward. |

### Tailscale, step by step

Only **one** of you needs a Tailscale account (free, using Google, Microsoft,
GitHub or Apple to sign in). The other joins with a key and never signs up.

**Player 1 (has the account):**
1. Connect page → Tailscale → **Install Tailscale**. Click **Yes** on the Windows prompt.
2. **Sign in.** Your browser opens; sign in or create the free account.
3. Open **How to add your buddy → create a key**, click *Generate auth key*
   (leave *Reusable* off), and send the `tskey-auth-…` key to your buddy privately.

**Player 2 (no account):**
1. Connect page → Tailscale → **Install Tailscale**, then click **Yes**.
2. **My buddy sent me a key**, paste it, then click **Join**.

Then each of you clicks **This is my buddy** next to the other's PC in the
device list. Nobody types IP addresses.

Treat the key like a password. Anyone with it can join your Tailscale network
until it's used or expires. One-off keys stop working after one use.

## Building from source

```sh
npm install
npm start          # run the app
npm test           # tests
npm run dist       # Windows installer + portable .exe, in dist/
```

Building on Linux/macOS needs Wine installed.

## Publishing an update

The app checks this repo's **GitHub Releases** (`phantomdenied/RetroConnect`,
set in `package.json` under `"retroconnect": { "githubRepo": … }`). When
a newer release exists it shows a **Download update** banner, and the button
downloads that release's `-win-setup.exe`. The repo has to be **public** for
this, because the app checks without signing in to GitHub.

**Each release:**
1. Bump `"version"` in `package.json` (e.g. `0.7.1` → `0.7.2`), commit, and
   push to `main`.
2. Tag it and push the tag:

   ```sh
   git tag v0.7.2
   git push origin v0.7.2
   ```

   The *Build Windows installer* workflow builds the installer and publishes
   a GitHub Release for the tag with both `.exe` files attached. It takes a
   few minutes. The tag must match the version in `package.json`.
3. Optional: edit the release on GitHub to write what changed. That text
   shows up in the update banner.

Both apps check at startup and every 6 hours (or click **Settings → App
updates → Check for updates**). Running the new installer upgrades in place
and keeps all settings.

**Other update file:** to announce updates from somewhere else instead, paste
a link to a public JSON file into **Settings → App updates → Update link**
(`npm run update-feed -- "https://download-link" "What changed"` prints one).
Leave it empty to use GitHub Releases.

## How it works

Each app runs a small file server on port 55440 (while *Share my library* is
on) and polls your buddy's. Every request needs the shared secret. Files are
only served by content hash from the app's own scan of your ROM and cores
folders, so nothing else on your PC is reachable.

| File | Role |
|---|---|
| `src/main/library.js` | Scans ROMs and cores (SHA-256 + CRC32, cached) |
| `src/main/server.js` | Sync server: manifest, current session, file downloads |
| `src/main/sync.js` | Guest side: matching, resumable downloads |
| `src/main/launcher.js` | Builds the RetroArch `--host` / `--connect` command |
| `src/main/netplay-control.js` | Follows RetroArch's log for player numbers; swap players |
| `src/main/systems.js` | System from folder names: core choice and box art |
| `src/main/gameinfo.js` | Language, hacks/homebrew, player counts and genres for the filters |
| `src/main/retroarch-installer.js` | Installs/updates RetroArch from libretro's stable builds |
| `src/main/retroarch-setup.js` | Controller detection, netplay-friendly `retroarch.cfg`, core list |
| `src/main/tailscale.js` | Installs Tailscale, signs in / joins with a key, lists devices |
| `src/main/updater.js` | Checks the public update file for a newer version |
| `src/main/controller.js` | App state: hosting, joining, buddy polling |
| `src/renderer/` | The UI |

Only share ROMs you own, and only between yourselves.
