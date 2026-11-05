import json
import os
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from retroconnect import platforms, sync as sync_mod
from retroconnect.config import Config
from retroconnect.launcher import build_command, netplay_overrides
from retroconnect.library import Library, hash_file, safe_relpath
from retroconnect.server import SyncServer, SyncState
from retroconnect.sync import HostClient, SyncError, Syncer, compare

SECRET = "test-secret"
TAG = platforms.platform_tag()
CORE_FILE = platforms.core_filename("snes9x_libretro")


def write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


@pytest.fixture
def host(tmp_path):
    roms, cores = tmp_path / "host_roms", tmp_path / "host_cores"
    write(roms / "SNES" / "Game.sfc", b"snes rom " * 5000)
    write(roms / "NES" / "Other.nes", b"nes rom")
    write(roms / "SNES" / "Game.srm", b"save file, not content")
    write(cores / CORE_FILE, b"host core binary v2")
    lib = Library(roms, cores, nickname="hosty", platform_tag=TAG)
    state = SyncState(lib, SECRET)
    server = SyncServer(state, "127.0.0.1", 0).start()
    yield lib, server
    server.stop()


@pytest.fixture
def guest(tmp_path):
    lib = Library(tmp_path / "guest_roms", tmp_path / "guest_cores", platform_tag=TAG)
    lib.roms_dir.mkdir()
    lib.cores_dir.mkdir()
    return lib


def client_for(server, secret=SECRET):
    return HostClient("127.0.0.1", server.port, secret)


def start_session(host_lib, server):
    rom = next(r for r in host_lib.scan_roms() if r["path"].endswith(".sfc"))
    core = host_lib.find_core("snes9x_libretro")
    server.state.session = {
        "host_nickname": "hosty", "platform": TAG, "retroarch_version": None,
        "netplay_port": 55435, "connection_mode": "direct", "relay_server": "nyc",
        "rom": rom, "core": core,
    }
    return rom, core


def test_scan_ignores_saves_and_hashes(host):
    lib, _ = host
    paths = [r["path"] for r in lib.scan_roms()]
    assert paths == ["NES/Other.nes", "SNES/Game.sfc"]
    assert lib.scan_cores()[0]["name"] == "snes9x_libretro"


def test_join_downloads_missing_core_and_rom(host, guest):
    host_lib, server = host
    rom, core = start_session(host_lib, server)
    client = client_for(server)
    result = Syncer(guest, client, log=lambda m: None).sync_session(client.session())
    assert result.rom_path == guest.roms_dir / "SNES" / "Game.sfc"
    assert hash_file(result.rom_path)["sha256"] == rom["sha256"]
    assert hash_file(result.core_path)["sha256"] == core["sha256"]
    assert sorted(result.downloaded) == sorted([CORE_FILE, "SNES/Game.sfc"])


def test_mismatched_files_are_replaced_and_backed_up(host, guest):
    host_lib, server = host
    rom, core = start_session(host_lib, server)
    write(guest.roms_dir / "SNES" / "Game.sfc", b"a bad dump")
    write(guest.cores_dir / CORE_FILE, b"old core v1")
    client = client_for(server)
    result = Syncer(guest, client, log=lambda m: None).sync_session(client.session())
    assert hash_file(result.rom_path)["sha256"] == rom["sha256"]
    assert hash_file(result.core_path)["sha256"] == core["sha256"]
    backups = sorted(p.name for p in guest.roms_dir.rglob("*.old"))
    assert len(backups) == 1 and backups[0].startswith("Game.sfc.")
    assert len(list(guest.cores_dir.glob("*.old"))) == 1
    # backups aren't treated as content or cores
    assert [r["path"] for r in guest.scan_roms()] == ["SNES/Game.sfc"]
    assert len(guest.scan_cores()) == 1


def test_matching_rom_under_another_name_is_reused(host, guest):
    host_lib, server = host
    rom, _ = start_session(host_lib, server)
    write(guest.roms_dir / "my-copy.sfc", (host_lib.roms_dir / "SNES" / "Game.sfc").read_bytes())
    client = client_for(server)
    result = Syncer(guest, client, log=lambda m: None).sync_session(client.session())
    assert result.rom_path == guest.roms_dir / "my-copy.sfc"
    assert "SNES/Game.sfc" not in result.downloaded


def test_resume_partial_download(host, guest):
    host_lib, server = host
    rom, _ = start_session(host_lib, server)
    data = (host_lib.roms_dir / "SNES" / "Game.sfc").read_bytes()
    write(guest.roms_dir / "SNES" / "Game.sfc.part", data[:1000])
    seen = []
    sync_mod.download_from_host(
        client_for(server), "rom", rom["sha256"], rom["size"],
        guest.roms_dir / "SNES" / "Game.sfc", "Game", lambda l, d, t: seen.append(d),
    )
    assert (guest.roms_dir / "SNES" / "Game.sfc").read_bytes() == data
    assert seen[-1] == len(data)


def test_corrupt_partial_is_rejected(host, guest):
    host_lib, server = host
    rom, _ = start_session(host_lib, server)
    write(guest.roms_dir / "SNES" / "Game.sfc.part", b"X" * 1000)  # wrong bytes
    with pytest.raises(SyncError, match="corrupted"):
        sync_mod.download_from_host(
            client_for(server), "rom", rom["sha256"], rom["size"],
            guest.roms_dir / "SNES" / "Game.sfc", "Game",
        )
    assert not (guest.roms_dir / "SNES" / "Game.sfc.part").exists()


def test_wrong_secret_rejected(host):
    _, server = host
    with pytest.raises(SyncError, match="shared secret"):
        client_for(server, "nope").manifest()


def test_only_hashed_files_are_served(host):
    _, server = host
    client = client_for(server)
    with pytest.raises(urllib.error.HTTPError) as exc:
        client.open("/files/rom/" + "0" * 64)
    assert exc.value.code == 404
    with pytest.raises(urllib.error.HTTPError) as exc:
        client.open("/files/rom/../../etc/passwd")
    assert exc.value.code == 404


def test_no_session_returns_none(host):
    _, server = host
    assert client_for(server).session() is None


def test_cross_platform_uses_buildbot(host, guest, monkeypatch):
    host_lib, server = host
    start_session(host_lib, server)
    client = client_for(server)
    session = client.session()
    session["platform"] = "windows-x86_64" if not TAG.startswith("windows") else "linux-x86_64"
    called = {}

    def fake_fetch(name, cores_dir, log):
        called["name"] = name
        return write(cores_dir / platforms.core_filename(name), b"buildbot core")

    monkeypatch.setattr(sync_mod, "fetch_core_from_buildbot", fake_fetch)
    result = Syncer(guest, client, log=lambda m: None).sync_session(session)
    assert called["name"] == "snes9x_libretro"
    assert any("buildbot" in w for w in result.warnings)

    # with the fallback disabled and no local core, it's a clear error
    (guest.cores_dir / CORE_FILE).unlink()
    with pytest.raises(SyncError, match="Online Updater"):
        Syncer(guest, client, buildbot_fallback=False, log=lambda m: None).sync_session(session)


def test_sync_all_and_compare(host, guest):
    host_lib, server = host
    write(guest.roms_dir / "Mine.gba", b"guest only")
    write(guest.roms_dir / "NES" / "Other.nes", b"different dump")
    client = client_for(server)
    remote = client.manifest()
    diff = compare(guest.manifest(), remote)
    assert diff == {
        "both": [],
        "only_host": ["SNES/Game.sfc"],
        "only_you": ["Mine.gba"],
        "different_version": ["NES/Other.nes"],
    }
    result = Syncer(guest, client, log=lambda m: None).sync_library(remote)
    assert set(result.downloaded) == {"SNES/Game.sfc", "NES/Other.nes", CORE_FILE}
    diff = compare(guest.manifest(), client.manifest())
    assert diff["both"] == ["NES/Other.nes", "SNES/Game.sfc"]


@pytest.mark.parametrize("bad", ["../evil", "/etc/passwd", "a/../../b", "C:/x", ""])
def test_unsafe_paths_rejected(bad):
    with pytest.raises(ValueError):
        safe_relpath(bad)


def test_launch_commands(tmp_path):
    cfg = Config(nickname="me", retroarch_command=["retroarch"])
    host = build_command(cfg, "host", Path("c.so"), Path("g.sfc"), overrides_path=Path("o.cfg"))
    assert host == ["retroarch", "-L", "c.so", "g.sfc", "--host", "--port", "55435",
                    "--nick", "me", "--appendconfig", "o.cfg"]
    guest = build_command(cfg, "guest", Path("c.so"), Path("g.sfc"), connect_to="100.1.2.3")
    assert "--connect" in guest and "100.1.2.3" in guest
    cfg.connection_mode = "relay"
    assert "--connect" not in build_command(cfg, "guest", Path("c.so"), Path("g.sfc"))
    assert 'netplay_use_mitm_server = "true"' in netplay_overrides(cfg, "host")
    assert 'netplay_use_mitm_server = "false"' in netplay_overrides(cfg, "guest")


def test_config_roundtrip(tmp_path):
    path = tmp_path / "config.json"
    cfg = Config()
    cfg.set_value("peer_address", "100.64.0.2")
    cfg.set_value("sync_port", "6000")
    cfg.set_value("buildbot_fallback", "no")
    cfg.set_value("core_map.sfc", "bsnes_libretro")
    cfg.save(path)
    loaded = Config.load(path)
    assert (loaded.peer_address, loaded.sync_port, loaded.buildbot_fallback) == ("100.64.0.2", 6000, False)
    assert loaded.core_for_extension(".SFC") == "bsnes_libretro"
    with pytest.raises(ValueError):
        cfg.set_value("connection_mode", "carrier-pigeon")
