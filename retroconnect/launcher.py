"""Build and run the RetroArch netplay command line."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional

from .config import Config


def _cfg_line(key: str, value: str) -> str:
    return f'{key} = "{value}"\n'


def netplay_overrides(cfg: Config, role: str) -> str:
    """Settings passed via --appendconfig (they take priority over retroarch.cfg)."""
    lines = _cfg_line("netplay_nickname", cfg.nickname.replace('"', ""))
    use_relay = cfg.connection_mode == "relay" and role == "host"
    lines += _cfg_line("netplay_use_mitm_server", "true" if use_relay else "false")
    if use_relay:
        lines += _cfg_line("netplay_mitm_server", cfg.relay_server)
    return lines


def build_command(
    cfg: Config,
    role: str,
    core_path: Path,
    rom_path: Path,
    connect_to: Optional[str] = None,
    port: Optional[int] = None,
    overrides_path: Optional[Path] = None,
) -> List[str]:
    """role is "host" or "guest"; guests in relay mode load the game and join
    from RetroArch's lobby, since relay sessions get an ID only at runtime."""
    ra = cfg.retroarch_cmd()
    if not ra:
        raise RuntimeError(
            "couldn't find RetroArch. Set it with: retroconnect config set retroarch_command <path>"
        )
    cmd = ra + ["-L", str(core_path), str(rom_path)]
    port = port or cfg.netplay_port
    if role == "host":
        cmd += ["--host", "--port", str(port)]
    elif cfg.connection_mode != "relay":
        if not connect_to:
            raise RuntimeError("no host address to connect to")
        cmd += ["--connect", connect_to, "--port", str(port)]
    cmd += ["--nick", cfg.nickname]
    if overrides_path:
        cmd += ["--appendconfig", str(overrides_path)]
    return cmd


def run(
    cfg: Config,
    role: str,
    core_path: Path,
    rom_path: Path,
    connect_to: Optional[str] = None,
    port: Optional[int] = None,
) -> int:
    """Start RetroArch and wait for it to close; returns its exit code."""
    tmp = tempfile.NamedTemporaryFile(
        "w", suffix=".cfg", prefix="retroconnect-", delete=False, encoding="utf-8"
    )
    with tmp:
        tmp.write(netplay_overrides(cfg, role))
    try:
        cmd = build_command(cfg, role, core_path, rom_path, connect_to, port, Path(tmp.name))
        proc = subprocess.Popen(cmd)
        try:
            return proc.wait()
        except KeyboardInterrupt:
            proc.terminate()
            return proc.wait()
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
