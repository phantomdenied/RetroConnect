"""User configuration, stored as JSON in the per-user config directory."""

from __future__ import annotations

import getpass
import json
import os
import shlex
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Dict, List, Optional, Union

from . import platforms

CONNECTION_MODES = ("direct", "tailscale", "relay")
RELAY_SERVERS = ("nyc", "madrid", "saopaulo", "singapore")

# File extension -> default core. Override per extension with `config set`.
DEFAULT_CORE_MAP: Dict[str, str] = {
    "nes": "fceumm_libretro",
    "fds": "fceumm_libretro",
    "unf": "fceumm_libretro",
    "sfc": "snes9x_libretro",
    "smc": "snes9x_libretro",
    "md": "genesis_plus_gx_libretro",
    "gen": "genesis_plus_gx_libretro",
    "smd": "genesis_plus_gx_libretro",
    "sms": "genesis_plus_gx_libretro",
    "gg": "genesis_plus_gx_libretro",
    "gb": "gambatte_libretro",
    "gbc": "gambatte_libretro",
    "gba": "mgba_libretro",
    "pce": "mednafen_pce_fast_libretro",
    "a26": "stella_libretro",
    "zip": "fbneo_libretro",
    "n64": "mupen64plus_next_libretro",
    "z64": "mupen64plus_next_libretro",
    "v64": "mupen64plus_next_libretro",
}


def _default_nick() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return "player"


@dataclass
class Config:
    nickname: str = field(default_factory=_default_nick)
    # Command that starts RetroArch, e.g. ["retroarch"] or
    # ["flatpak", "run", "org.libretro.RetroArch"]. Empty = auto-detect.
    retroarch_command: List[str] = field(default_factory=list)
    roms_dir: str = str(Path("~") / "RetroConnect" / "roms")
    cores_dir: str = ""  # empty = auto-detect RetroArch's cores folder
    # Your buddy's address (LAN IP, public IP, or Tailscale IP/name).
    # Only the guest needs this.
    peer_address: str = ""
    connection_mode: str = "direct"  # direct | tailscale | relay
    relay_server: str = "nyc"
    netplay_port: int = 55435
    sync_port: int = 55440
    sync_bind: str = "0.0.0.0"
    shared_secret: str = ""
    core_map: Dict[str, str] = field(default_factory=lambda: dict(DEFAULT_CORE_MAP))
    # If you're on different OSes the host can't send its core binary, so
    # fetch the same core from the libretro buildbot instead.
    buildbot_fallback: bool = True

    # ----- derived paths -------------------------------------------------

    def roms_path(self) -> Path:
        return Path(os.path.expanduser(self.roms_dir))

    def retroarch_cmd(self) -> List[str]:
        return list(self.retroarch_command) or platforms.detect_retroarch()

    def cores_path(self) -> Path:
        if self.cores_dir:
            return Path(os.path.expanduser(self.cores_dir))
        return platforms.detect_cores_dir(self.retroarch_cmd())

    def core_for_extension(self, ext: str) -> Optional[str]:
        return self.core_map.get(ext.lower().lstrip("."))

    # ----- persistence ---------------------------------------------------

    @classmethod
    def load(cls, path: Optional[Path] = None) -> "Config":
        path = path or default_config_path()
        if not path.exists():
            return cls()
        data = json.loads(path.read_text(encoding="utf-8"))
        known = {f.name for f in fields(cls)}
        cfg = cls(**{k: v for k, v in data.items() if k in known})
        cfg.validate()
        return cfg

    def save(self, path: Optional[Path] = None) -> Path:
        self.validate()
        path = path or default_config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2) + "\n", encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)  # holds the shared secret
        except OSError:
            pass
        os.replace(tmp, path)
        return path

    def validate(self) -> None:
        if self.connection_mode not in CONNECTION_MODES:
            raise ValueError(
                f"connection_mode must be one of {', '.join(CONNECTION_MODES)}"
            )
        for name in ("netplay_port", "sync_port"):
            port = getattr(self, name)
            if not isinstance(port, int) or not (0 < port < 65536):
                raise ValueError(f"{name} must be a port number (1-65535)")

    def set_value(self, key: str, raw: str) -> None:
        """Set a field from a command-line string, coercing to its type."""
        if key.startswith("core_map."):
            ext = key.split(".", 1)[1].lstrip(".").lower()
            if raw:
                self.core_map[ext] = raw
            else:
                self.core_map.pop(ext, None)
            return
        current = {f.name: f for f in fields(self)}
        if key not in current:
            raise KeyError(key)
        value: Union[str, int, bool, List[str]]
        old = getattr(self, key)
        if isinstance(old, bool):
            value = raw.strip().lower() in ("1", "true", "yes", "on")
        elif isinstance(old, int):
            value = int(raw)
        elif isinstance(old, list):
            if platforms.os_name() == "windows":
                # Non-POSIX mode keeps backslashes but also keeps the quotes.
                value = [t.strip('"') for t in shlex.split(raw, posix=False)]
            else:
                value = shlex.split(raw)
        elif isinstance(old, dict):
            raise KeyError(f"{key} (use {key}.<ext>)")
        else:
            value = raw
        setattr(self, key, value)
        self.validate()


def default_config_path() -> Path:
    return platforms.config_dir() / "config.json"
