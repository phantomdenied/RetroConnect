"""Command-line interface: `retroconnect <command>`."""

from __future__ import annotations

import argparse
import json
import secrets
import shutil
import socket
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path
from typing import List, Optional

from . import __version__, platforms
from .config import CONNECTION_MODES, Config, default_config_path
from .library import Library, retroarch_version
from .server import SyncServer, SyncState
from .sync import HostClient, SyncError, Syncer, compare
from . import launcher


# ----- helpers --------------------------------------------------------------

def load_config(args) -> Config:
    return Config.load(Path(args.config) if args.config else None)


def make_library(cfg: Config) -> Library:
    return Library(
        cfg.roms_path(),
        cfg.cores_path(),
        cache_path=platforms.config_dir() / "hash-cache.json",
        nickname=cfg.nickname,
        retroarch_cmd=cfg.retroarch_cmd(),
    )


def make_client(cfg: Config) -> HostClient:
    if not cfg.shared_secret:
        raise SyncError("no shared_secret set; run `retroconnect init` first")
    return HostClient(cfg.peer_address, cfg.sync_port, cfg.shared_secret)


class Progress:
    def __init__(self):
        self.last = 0.0

    def __call__(self, label: str, done: int, total: int) -> None:
        now = time.monotonic()
        if done < total and now - self.last < 0.2:
            return
        self.last = now
        pct = 100 * done / total if total else 100
        sys.stderr.write(f"\r  {label}: {pct:5.1f}% ({done / 1e6:.1f}/{total / 1e6:.1f} MB)")
        if done >= total:
            sys.stderr.write("\n")
        sys.stderr.flush()


def ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    answer = input(f"{prompt}{suffix}: ").strip()
    return answer or default


def local_addresses() -> List[str]:
    addrs = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("192.0.2.1", 9))  # no packets sent; just picks the LAN interface
            addrs.append(s.getsockname()[0])
    except OSError:
        pass
    if shutil.which("tailscale"):
        try:
            out = subprocess.run(
                ["tailscale", "ip", "-4"], capture_output=True, text=True, timeout=5
            )
            addrs += [f"{a} (Tailscale)" for a in out.stdout.split() if a]
        except (OSError, subprocess.SubprocessError):
            pass
    return addrs


def pick_rom(roms: List[dict], query: str) -> dict:
    q = query.lower().replace("\\", "/")
    exact = [r for r in roms if r["path"].lower() == q]
    if exact:
        return exact[0]
    matches = [r for r in roms if q in r["path"].lower()]
    if not matches:
        raise SyncError(f"no ROM matching {query!r} in your library (try `retroconnect scan`)")
    if len(matches) == 1:
        return matches[0]
    print(f"{len(matches)} ROMs match {query!r}:")
    for i, r in enumerate(matches, 1):
        print(f"  {i}. {r['path']}")
    if not sys.stdin.isatty():
        raise SyncError("be more specific")
    choice = ask("Pick a number")
    if not choice.isdigit() or not 1 <= int(choice) <= len(matches):
        raise SyncError("no game picked")
    return matches[int(choice) - 1]


def print_result(result) -> None:
    for item in result.downloaded:
        print(f"  downloaded {item}")
    for warn in result.warnings:
        print(f"  warning: {warn}")


# ----- commands -------------------------------------------------------------

def cmd_init(args) -> int:
    path = Path(args.config) if args.config else default_config_path()
    cfg = Config.load(path)
    print("RetroConnect setup (press Enter to keep the value in brackets)\n")
    cfg.nickname = ask("Your nickname", cfg.nickname)
    cfg.roms_dir = ask("ROM folder", cfg.roms_dir)
    ra = " ".join(cfg.retroarch_cmd())
    ra = ask("RetroArch command", ra)
    if ra:
        cfg.set_value("retroarch_command", ra)
    cfg.cores_dir = ask("RetroArch cores folder", str(cfg.cores_path()))
    mode = ""
    while mode not in CONNECTION_MODES:
        mode = ask(f"Connection mode ({'/'.join(CONNECTION_MODES)})", cfg.connection_mode)
    cfg.connection_mode = mode
    cfg.peer_address = ask(
        "Buddy's address (only needed when you join; LAN/public/Tailscale IP)",
        cfg.peer_address,
    )
    secret = ask(
        "Shared secret (paste your buddy's, or leave blank to generate one)",
        cfg.shared_secret,
    )
    cfg.shared_secret = secret or secrets.token_urlsafe(18)
    cfg.roms_path().mkdir(parents=True, exist_ok=True)
    saved = cfg.save(path)
    print(f"\nSaved {saved}")
    print(f"Shared secret: {cfg.shared_secret}")
    print("Send this secret to your buddy privately; you both need the same one.")
    return 0


def cmd_config(args) -> int:
    path = Path(args.config) if args.config else default_config_path()
    cfg = Config.load(path)
    if args.action == "path":
        print(path)
    elif args.action == "show":
        data = asdict(cfg)
        if data["shared_secret"] and not args.reveal:
            data["shared_secret"] = "******** (use --reveal)"
        data["_resolved"] = {
            "retroarch_command": cfg.retroarch_cmd(),
            "cores_dir": str(cfg.cores_path()),
            "roms_dir": str(cfg.roms_path()),
            "platform": platforms.platform_tag(),
        }
        print(json.dumps(data, indent=2))
    elif args.action == "set":
        if args.key is None or args.value is None:
            print("usage: retroconnect config set <key> <value>", file=sys.stderr)
            return 2
        try:
            cfg.set_value(args.key, args.value)
        except KeyError:
            print(f"unknown setting: {args.key}", file=sys.stderr)
            return 2
        except ValueError as exc:
            print(f"invalid value: {exc}", file=sys.stderr)
            return 2
        cfg.save(path)
        print(f"{args.key} updated")
    return 0


def cmd_scan(args) -> int:
    cfg = load_config(args)
    manifest = make_library(cfg).manifest()
    print(f"Platform: {manifest['platform']}   RetroArch: {manifest['retroarch_version'] or '?'}")
    print(f"\nROMs in {cfg.roms_path()} ({len(manifest['roms'])}):")
    for r in manifest["roms"]:
        core = cfg.core_for_extension(Path(r["path"]).suffix) or "?"
        print(f"  {r['path']}  crc={r['crc32']}  core={core}")
    print(f"\nCores in {cfg.cores_path()} ({len(manifest['cores'])}):")
    for c in manifest["cores"]:
        print(f"  {c['name']}")
    return 0


def cmd_doctor(args) -> int:
    cfg = load_config(args)
    ok = True

    def check(cond: bool, good: str, bad: str) -> None:
        nonlocal ok
        print(("  ok    " if cond else "  FIX   ") + (good if cond else bad))
        ok = ok and cond

    ra = cfg.retroarch_cmd()
    print(f"RetroConnect {__version__} on {platforms.platform_tag()}")
    check(bool(ra), f"RetroArch: {' '.join(ra)}", "RetroArch not found (config set retroarch_command ...)")
    if ra:
        v = retroarch_version(ra)
        check(bool(v), f"RetroArch version {v}", "couldn't run `retroarch --version`")
    check(cfg.roms_path().is_dir(), f"ROM folder {cfg.roms_path()}", f"ROM folder {cfg.roms_path()} doesn't exist")
    check(cfg.cores_path().is_dir(), f"cores folder {cfg.cores_path()}", f"cores folder {cfg.cores_path()} doesn't exist")
    check(bool(cfg.shared_secret), "shared secret set", "no shared secret (run `retroconnect init`)")
    print(f"  info  connection mode: {cfg.connection_mode}")
    if cfg.peer_address and cfg.shared_secret:
        try:
            m = make_client(cfg).manifest()
            check(True, f"reached {m['nickname'] or 'host'} at {cfg.peer_address} ({len(m['roms'])} ROMs)", "")
        except SyncError as exc:
            print(f"  info  buddy not reachable right now: {exc}")
    return 0 if ok else 1


def _session_for(cfg: Config, library: Library, rom: dict, core: dict) -> dict:
    return {
        "host_nickname": cfg.nickname,
        "platform": library.platform_tag,
        "retroarch_version": retroarch_version(library.retroarch_cmd),
        "netplay_port": cfg.netplay_port,
        "connection_mode": cfg.connection_mode,
        "relay_server": cfg.relay_server,
        "rom": rom,
        "core": core,
        "started_at": int(time.time()),
    }


def _print_reachability(cfg: Config, server: SyncServer) -> None:
    addrs = local_addresses()
    print(f"Sync server listening on port {server.port}.")
    if addrs:
        print("Your buddy should set peer_address to one of: " + ", ".join(addrs))
    if cfg.connection_mode == "direct":
        print(
            f"Direct mode: over the internet, forward TCP {cfg.sync_port} (file sync) and "
            f"TCP {cfg.netplay_port} (netplay) on your router."
        )
    elif cfg.connection_mode == "relay":
        print(
            f"Relay mode: netplay goes through the '{cfg.relay_server}' relay, but file sync "
            f"still needs TCP {cfg.sync_port} reachable (port forward, or use Tailscale)."
        )


def _start_server(cfg: Config, library: Library, port: Optional[int] = None) -> SyncServer:
    if not cfg.shared_secret:
        raise SyncError("no shared_secret set; run `retroconnect init` first")
    state = SyncState(library, cfg.shared_secret)
    print("Scanning your library...")
    state.manifest()
    try:
        server = SyncServer(state, cfg.sync_bind, cfg.sync_port if port is None else port)
    except OSError as exc:
        raise SyncError(f"can't open sync port {cfg.sync_port}: {exc}") from None
    return server.start()


def cmd_serve(args) -> int:
    cfg = load_config(args)
    server = _start_server(cfg, make_library(cfg))
    _print_reachability(cfg, server)
    print("Your buddy can now run `retroconnect games` / `retroconnect sync`. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print()
    finally:
        server.stop()
    return 0


def cmd_host(args) -> int:
    cfg = load_config(args)
    library = make_library(cfg)
    rom = pick_rom(library.scan_roms(), args.game)
    core_name = args.core or cfg.core_for_extension(Path(rom["path"]).suffix)
    if not core_name:
        raise SyncError(
            f"don't know which core runs {Path(rom['path']).suffix} files; pass --core, e.g. "
            "--core snes9x_libretro"
        )
    if not core_name.endswith("_libretro"):
        core_name += "_libretro"
    core = library.find_core(core_name)
    if not core:
        raise SyncError(
            f"{core_name} isn't installed in {library.cores_dir}. "
            "Get it with RetroArch's Online Updater > Core Downloader."
        )

    server = _start_server(cfg, library)
    server.state.session = _session_for(cfg, library, rom, core)
    print(f"\nHosting {rom['path']} with {core_name}")
    _print_reachability(cfg, server)
    print("Tell your buddy to run: retroconnect join\n")
    try:
        if args.no_launch:
            print("(--no-launch) Sync server only. Ctrl+C to stop.")
            while True:
                time.sleep(1)
        launcher.run(cfg, "host", library.core_path(core), library.rom_path(rom))
    except KeyboardInterrupt:
        print()
    finally:
        server.state.session = None
        server.stop()
    return 0


def cmd_join(args) -> int:
    cfg = load_config(args)
    library = make_library(cfg)
    client = make_client(cfg)
    session = client.session()
    if session is None:
        raise SyncError("your buddy isn't hosting a game right now (they should run `retroconnect host <game>`)")
    print(
        f"{session['host_nickname']} is hosting {session['rom']['path']} "
        f"({session['core']['name']})"
    )
    syncer = Syncer(library, client, cfg.buildbot_fallback, Progress())
    result = syncer.sync_session(session)
    print_result(result)
    print("Core and ROM match the host.")
    if args.sync_only:
        return 0
    if session.get("connection_mode") == "relay" or cfg.connection_mode == "relay":
        cfg.connection_mode = "relay"
        print(
            "Relay mode: in RetroArch open Netplay > Refresh Host List and join "
            f"{session['host_nickname']}'s game."
        )
    launcher.run(
        cfg, "guest", result.core_path, result.rom_path,
        connect_to=cfg.peer_address, port=session.get("netplay_port"),
    )
    return 0


def cmd_sync(args) -> int:
    cfg = load_config(args)
    if not args.all and not args.game:
        print("say what to sync: `retroconnect sync <game>` or `retroconnect sync --all`", file=sys.stderr)
        return 2
    library = make_library(cfg)
    client = make_client(cfg)
    manifest = client.manifest()
    syncer = Syncer(library, client, cfg.buildbot_fallback, Progress())
    result = syncer.sync_library(manifest, None if args.all else args.game, not args.no_cores)
    print_result(result)
    if not result.downloaded:
        print("Already in sync.")
    if manifest["platform"] != library.platform_tag and not args.no_cores:
        print(
            f"note: host is on {manifest['platform']}, so cores weren't copied; "
            "they'll be fetched per game when you join."
        )
    return 0


def cmd_games(args) -> int:
    cfg = load_config(args)
    library = make_library(cfg)
    remote = make_client(cfg).manifest()
    diff = compare(library.manifest(), remote)
    who = remote.get("nickname") or "host"
    sections = [
        ("Ready to play (you both have it)", diff["both"]),
        (f"Different version than {who}'s (sync will fix)", diff["different_version"]),
        (f"Only {who} has (sync will download)", diff["only_host"]),
        ("Only you have", diff["only_you"]),
    ]
    for title, items in sections:
        print(f"{title}: {len(items)}")
        for item in items:
            print(f"  {item}")
    return 0


# ----- entry point ----------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="retroconnect",
        description="Sync cores/ROMs with your buddy and start RetroArch netplay.",
    )
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    p.add_argument("--config", help="path to config.json (default: per-user config dir)")
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="interactive first-time setup").set_defaults(func=cmd_init)

    c = sub.add_parser("config", help="show or change settings")
    c.add_argument("action", choices=["show", "set", "path"])
    c.add_argument("key", nargs="?")
    c.add_argument("value", nargs="?")
    c.add_argument("--reveal", action="store_true", help="show the shared secret")
    c.set_defaults(func=cmd_config)

    sub.add_parser("scan", help="list your ROMs and cores").set_defaults(func=cmd_scan)
    sub.add_parser("doctor", help="check your setup").set_defaults(func=cmd_doctor)
    sub.add_parser("serve", help="share your library without starting a game").set_defaults(func=cmd_serve)

    h = sub.add_parser("host", help="host a game; your buddy gets the same core + ROM")
    h.add_argument("game", help="ROM name or part of it")
    h.add_argument("--core", help="core to use, e.g. snes9x_libretro (default: by file extension)")
    h.add_argument("--no-launch", action="store_true", help="run the sync server but don't start RetroArch")
    h.set_defaults(func=cmd_host)

    j = sub.add_parser("join", help="sync whatever your buddy is hosting and connect")
    j.add_argument("--sync-only", action="store_true", help="download files but don't start RetroArch")
    j.set_defaults(func=cmd_join)

    s = sub.add_parser("sync", help="download ROMs/cores from your buddy ahead of time")
    s.add_argument("game", nargs="?", help="only ROMs whose name contains this")
    s.add_argument("--all", action="store_true", help="everything the host has")
    s.add_argument("--no-cores", action="store_true", help="skip cores")
    s.set_defaults(func=cmd_sync)

    sub.add_parser("games", help="compare your library with your buddy's").set_defaults(func=cmd_games)
    return p


def main(argv: Optional[List[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args) or 0
    except SyncError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
