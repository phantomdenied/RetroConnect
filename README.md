# RetroConnect

Play RetroArch netplay with a friend, with no "content mismatch" errors.
The host picks a game, and the guest automatically gets the **exact same core
and ROM** (sent straight from the host when missing or different), then
RetroArch launches and connects for both of you.

- **ROMs** are matched by SHA-256. If you already have the identical file
  (under any name) it's used; otherwise it's downloaded from the host.
- **Cores** on the same OS/CPU are copied from the host so you run the
  identical build. Across different OSes (Windows vs. Mac, say) a native
  binary can't be shared, so the same core is fetched from the libretro
  buildbot instead, with a warning to keep versions in step.
- Anything replaced is kept as `<file>.<timestamp>.old`, never deleted.
- Downloads resume if interrupted and are hash-verified before use.

Pure Python 3.9+, no dependencies.

## Install (both of you)

```sh
git clone https://github.com/phantomdenied/retroconnect
cd retroconnect
pip install .            # or run without installing: python -m retroconnect ...
retroconnect init        # one person leaves the secret blank to generate it,
                         # then sends it to the other, who pastes it in
retroconnect doctor      # checks RetroArch, folders, and whether your buddy is reachable
```

Put your ROMs in the ROM folder you chose during `init` (subfolders are fine).

## Playing

**Host:**

```sh
retroconnect host "super mario world"   # any part of the file name
```

This starts the sync server and launches RetroArch as netplay host. It picks
the core from the file extension (`.sfc` → snes9x, `.nes` → fceumm, …); use
`--core bsnes_libretro` to override it.

**Guest:**

```sh
retroconnect join
```

This sees what the host is playing, downloads anything missing or mismatched,
and launches RetroArch connected to the host.

**Other commands:**

| Command | What it does |
|---|---|
| `retroconnect games` | Compare libraries: games you both have, only one has, or different versions of |
| `retroconnect sync --all` | Pull the host's whole library ahead of time (host runs `retroconnect serve`) |
| `retroconnect sync zelda` | Pull only matching ROMs |
| `retroconnect scan` | List your ROMs and cores |
| `retroconnect config show` | Show settings (`config set <key> <value>` to change one) |

## Connecting

Set the mode with `retroconnect config set connection_mode <mode>`. The guest
always sets `peer_address` to the host's address.

| Mode | Install | What the host opens |
|---|---|---|
| `tailscale` (recommended) | Tailscale on both PCs | Nothing. Use the host's `100.x.y.z` Tailscale IP as `peer_address`. Traffic is encrypted. |
| `direct` | Nothing | Forward TCP **55440** (file sync) and **55435** (netplay) to the host PC. Use the host's public IP. |
| `relay` | Nothing | Netplay goes through a libretro relay (`relay_server`: nyc, madrid, saopaulo, singapore), and the guest joins from RetroArch's **Netplay → Refresh Host List**. **File sync still needs port 55440 reachable**, so pair it with Tailscale or a port forward, or sync ahead of time on a LAN. |

On the same home network, `direct` with the LAN IP just works.

## Security notes

- Every request needs the shared secret, and the host only serves files from
  its own scan, looked up by hash, so no other paths on the PC are reachable.
- In `direct` mode, transfers (including the secret) are unencrypted HTTP.
  Use Tailscale if you're going over the internet.
- Only share ROMs you own, and only between yourselves.

## Settings

Stored in `config.json` (find it with `retroconnect config path`):

| Key | Default | |
|---|---|---|
| `nickname` | your username | shown in netplay |
| `roms_dir` | `~/RetroConnect/roms` | |
| `cores_dir` | auto-detected | RetroArch's `cores` folder |
| `retroarch_command` | auto-detected | e.g. `flatpak run org.libretro.RetroArch` |
| `peer_address` | | your buddy's IP or Tailscale name |
| `connection_mode` | `direct` | `direct`, `tailscale`, `relay` |
| `netplay_port` / `sync_port` | 55435 / 55440 | |
| `buildbot_fallback` | `true` | fetch cores from libretro when OSes differ |
| `core_map.<ext>` | see `config.py` | e.g. `config set core_map.sfc bsnes_libretro` |

## Development

```sh
pip install -e '.[dev]'
pytest
```
