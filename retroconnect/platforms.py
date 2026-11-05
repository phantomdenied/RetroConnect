"""Platform detection: OS/arch tags, core file names, default install paths."""

from __future__ import annotations

import os
import platform
import shutil
import sys
from pathlib import Path
from typing import List, Optional

BUILDBOT_BASE = "https://buildbot.libretro.com/nightly"


def os_name() -> str:
    if sys.platform.startswith("win"):
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    return "linux"


def arch_name() -> str:
    machine = platform.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x86_64"
    if machine in ("arm64", "aarch64"):
        return "arm64"
    if machine in ("i386", "i686", "x86"):
        return "x86"
    return machine or "unknown"


def platform_tag() -> str:
    """Cores are native binaries, so they're only interchangeable on the same tag."""
    return f"{os_name()}-{arch_name()}"


def core_extension(os_tag: Optional[str] = None) -> str:
    os_tag = os_tag or os_name()
    return {"windows": ".dll", "macos": ".dylib"}.get(os_tag, ".so")


def core_filename(core_name: str, os_tag: Optional[str] = None) -> str:
    """'snes9x_libretro' -> 'snes9x_libretro.so' (or .dll / .dylib)."""
    return core_name + core_extension(os_tag)


def core_name_from_file(filename: str) -> Optional[str]:
    """'snes9x_libretro.dll' -> 'snes9x_libretro'; None if it's not a core."""
    stem, ext = os.path.splitext(filename)
    if ext.lower() not in (".so", ".dll", ".dylib"):
        return None
    if not stem.endswith("_libretro"):
        return None
    return stem


def buildbot_core_url(core_name: str, tag: Optional[str] = None) -> Optional[str]:
    """URL of the libretro nightly build of a core for this platform (zipped)."""
    tag = tag or platform_tag()
    os_tag, _, arch = tag.partition("-")
    fname = core_filename(core_name, os_tag)
    if os_tag == "linux" and arch == "x86_64":
        return f"{BUILDBOT_BASE}/linux/x86_64/latest/{fname}.zip"
    if os_tag == "windows" and arch in ("x86_64", "x86"):
        return f"{BUILDBOT_BASE}/windows/{arch}/latest/{fname}.zip"
    if os_tag == "macos" and arch in ("x86_64", "arm64"):
        return f"{BUILDBOT_BASE}/apple/osx/{arch}/latest/{fname}.zip"
    return None


def _home() -> Path:
    return Path.home()


def detect_retroarch() -> List[str]:
    """Best guess at the command that starts RetroArch; [] if not found."""
    for exe in ("retroarch", "RetroArch", "retroarch.exe"):
        found = shutil.which(exe)
        if found:
            return [found]
    candidates: List[Path] = []
    if os_name() == "windows":
        appdata = os.environ.get("APPDATA", "")
        candidates += [
            Path(r"C:\RetroArch-Win64\retroarch.exe"),
            Path(r"C:\RetroArch\retroarch.exe"),
            Path(appdata) / "RetroArch" / "retroarch.exe",
            Path(r"C:\Program Files (x86)\Steam\steamapps\common\RetroArch\retroarch.exe"),
        ]
    elif os_name() == "macos":
        candidates += [
            Path("/Applications/RetroArch.app/Contents/MacOS/RetroArch"),
            _home() / "Applications/RetroArch.app/Contents/MacOS/RetroArch",
        ]
    for c in candidates:
        if c.is_file():
            return [str(c)]
    if os_name() == "linux" and shutil.which("flatpak"):
        if (_home() / ".var/app/org.libretro.RetroArch").is_dir():
            return ["flatpak", "run", "org.libretro.RetroArch"]
    return []


def detect_cores_dir(retroarch_cmd: Optional[List[str]] = None) -> Path:
    """Where RetroArch keeps its cores on this machine (first existing guess)."""
    candidates: List[Path] = []
    if os_name() == "windows":
        # Portable Windows installs keep cores next to retroarch.exe.
        if retroarch_cmd:
            candidates.append(Path(retroarch_cmd[0]).parent / "cores")
        appdata = os.environ.get("APPDATA", "")
        candidates += [
            Path(r"C:\RetroArch-Win64\cores"),
            Path(appdata) / "RetroArch" / "cores",
        ]
    elif os_name() == "macos":
        candidates.append(_home() / "Library/Application Support/RetroArch/cores")
    else:
        candidates += [
            _home() / ".config/retroarch/cores",
            _home() / ".var/app/org.libretro.RetroArch/config/retroarch/cores",
        ]
    for c in candidates:
        if c.is_dir():
            return c
    # Nothing exists yet: use the most conventional location for this OS.
    return candidates[0]


def config_dir() -> Path:
    override = os.environ.get("RETROCONNECT_HOME")
    if override:
        return Path(override)
    if os_name() == "windows":
        return Path(os.environ.get("APPDATA", str(_home()))) / "RetroConnect"
    if os_name() == "macos":
        return _home() / "Library/Application Support/RetroConnect"
    xdg = os.environ.get("XDG_CONFIG_HOME")
    return (Path(xdg) if xdg else _home() / ".config") / "retroconnect"
