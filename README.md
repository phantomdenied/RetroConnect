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
- **Cross-platform**: a Windows core can't run on a Mac, so when you're on
  different systems the same core is downloaded from the official libretro
  buildbot instead.
- Anything replaced is kept as `<file>.<timestamp>.old`, never deleted.

## Install

Download the installer for your system from the
[Releases page](https://github.com/phantomdenied/RetroConnect/releases):

| System | File |
|---|---|
| Windows | `RetroConnect-x.y.z-win-setup.exe` (or `-win-portable.exe`, no install) |
| macOS | `RetroConnect-x.y.z-mac-arm64.dmg` (Apple Silicon) or `-mac-x64.dmg` (Intel) |
| Linux | `.AppImage` (any distro) or `.deb` |

The builds aren't code-signed, so the first launch needs one extra step:

- **Windows:** on "Windows protected your PC", click **More info → Run anyway**.
- **macOS:** right-click the app → **Open**. If macOS says it's "damaged", run
  `xattr -cr /Applications/RetroConnect.app` in Terminal once.
- **Linux AppImage:** `chmod +x RetroConnect-*.AppImage`, then run it.

You also need [RetroArch](https://www.retroarch.com/?page=platforms) installed.
RetroConnect finds it automatically in the usual places.

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
npm run dist       # installer for the current OS, in dist/
```

To publish installers for all three systems, push a version tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

GitHub Actions (`.github/workflows/build.yml`) builds Windows, macOS and Linux
installers and attaches them to a GitHub Release. You can also run the
workflow by hand from the Actions tab and download the installers from the
run page.

## How it works

Each app runs a small file server on port 55440 (while *Share my library* is
on) and polls your buddy's. Every request needs the shared secret. Files are
only served by content hash from the app's own scan of your ROM and cores
folders, so nothing else on your PC is reachable.

| File | Role |
|---|---|
| `src/main/library.js` | Scans ROMs and cores (SHA-256 + CRC32, cached) |
| `src/main/server.js` | Sync server: manifest, current session, file downloads |
| `src/main/sync.js` | Guest side: matching, resumable downloads, buildbot fallback |
| `src/main/launcher.js` | Builds the RetroArch `--host` / `--connect` command |
| `src/main/controller.js` | App state: hosting, joining, buddy polling |
| `src/renderer/` | The UI |

Only share ROMs you own, and only between yourselves.
