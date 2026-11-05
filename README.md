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

## Install (Windows)

Download from the [Releases page](https://github.com/phantomdenied/RetroConnect/releases):

- `RetroConnect-x.y.z-win-setup.exe`: normal installer (Start menu shortcut, uninstaller)
- `RetroConnect-x.y.z-win-portable.exe`: no install, just run it

The app isn't code-signed, so the first time Windows shows **"Windows protected
your PC"**. Click **More info → Run anyway**.

When you first open it, Windows Firewall asks whether RetroConnect may use the
network. Click **Allow** (private networks is enough with Tailscale or a home
network). RetroArch asks the same the first time you host.

You also need [RetroArch](https://www.retroarch.com/?page=platforms) installed.
RetroConnect looks in the usual places (`C:\RetroArch-Win64`, Steam, `%APPDATA%`);
otherwise point to `retroarch.exe` in Settings.

## First run

The setup wizard asks for:

1. **Your nickname and ROM folder.** Games your buddy sends go here too.
2. **RetroArch.** Usually detected automatically.
3. **Pairing.** One of you clicks *I'm first* and sends the generated secret
   to the other, who picks *My buddy sent me one* and pastes it.

Then, on the **Connect** page, enter each other's address.

## Connecting

| Mode | Setup |
|---|---|
| **Tailscale** (recommended) | Both install [Tailscale](https://tailscale.com/download). Use each other's `100.x.y.z` address. Traffic is encrypted and there's no router setup. |
| **Direct** | Same Wi-Fi: use the LAN address shown on the Connect page. Over the internet: the host forwards TCP **55440** (file sync) and **55435** (netplay). File traffic is unencrypted in this mode. |
| **Relay** | Gameplay goes through a libretro relay server, and the guest joins from RetroArch's *Netplay → Refresh Host List*. Downloading games still needs port 55440 reachable, so pair it with Tailscale or a port forward. |

## Building from source

```sh
npm install
npm start          # run the app
npm test           # tests
npm run dist       # Windows installer + portable .exe, in dist/
```

Building on Linux/macOS needs Wine installed. To publish a release, push a version tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions (`.github/workflows/build.yml`) builds the Windows installer and
attaches it to a GitHub Release. You can also run the workflow by hand from
the Actions tab and download the installer from the run page.

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
| `src/main/controller.js` | App state: hosting, joining, buddy polling |
| `src/renderer/` | The UI |

Only share ROMs you own, and only between yourselves.
