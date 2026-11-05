"""Scan local ROMs and cores and fingerprint them (SHA-256 + CRC32).

RetroArch netplay refuses to connect unless both sides run the same content,
and desyncs if the cores differ, so everything is identified by content hash
rather than by file name.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import threading
import zlib
from pathlib import Path, PurePosixPath
from typing import Dict, List, Optional

from . import platforms

MANIFEST_VERSION = 1
CHUNK = 1024 * 1024

# Things that commonly live next to ROMs but aren't content.
IGNORED_EXTENSIONS = {
    ".srm", ".sav", ".state", ".png", ".jpg", ".jpeg", ".txt", ".nfo",
    ".cfg", ".opt", ".rmp", ".lpl", ".part", ".old", ".tmp", ".auto",
}
_STATE_SLOT = re.compile(r"\.state\d+$", re.IGNORECASE)


def hash_file(path: Path) -> Dict[str, str]:
    sha = hashlib.sha256()
    crc = 0
    with open(path, "rb") as fh:
        while True:
            block = fh.read(CHUNK)
            if not block:
                break
            sha.update(block)
            crc = zlib.crc32(block, crc)
    return {"sha256": sha.hexdigest(), "crc32": f"{crc & 0xFFFFFFFF:08x}"}


def is_content_file(path: Path) -> bool:
    name = path.name
    if name.startswith("."):
        return False
    suffix = path.suffix.lower()
    return not (suffix in IGNORED_EXTENSIONS or _STATE_SLOT.search(name))


def safe_relpath(rel: str) -> PurePosixPath:
    """Validate a relative path that came over the network."""
    p = PurePosixPath(rel.replace("\\", "/"))
    if (
        not rel
        or p.is_absolute()
        or any(part in ("", ".", "..") for part in p.parts)
        or ":" in p.parts[0]
    ):
        raise ValueError(f"unsafe path from host: {rel!r}")
    return p


class HashCache:
    """Remembers hashes keyed by (path, size, mtime) so rescans are cheap."""

    def __init__(self, path: Optional[Path]):
        self.path = path
        self._lock = threading.Lock()
        self._data: Dict[str, dict] = {}
        self._dirty = False
        if path and path.exists():
            try:
                self._data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self._data = {}

    def get(self, path: Path) -> Dict[str, str]:
        st = path.stat()
        key = str(path.resolve())
        with self._lock:
            hit = self._data.get(key)
            if hit and hit["size"] == st.st_size and hit["mtime_ns"] == st.st_mtime_ns:
                return {"sha256": hit["sha256"], "crc32": hit["crc32"]}
        digests = hash_file(path)
        with self._lock:
            self._data[key] = {"size": st.st_size, "mtime_ns": st.st_mtime_ns, **digests}
            self._dirty = True
        return digests

    def save(self) -> None:
        with self._lock:
            if not (self.path and self._dirty):
                return
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data), encoding="utf-8")
            os.replace(tmp, self.path)
            self._dirty = False


_version_cache: Dict[str, Optional[str]] = {}


def retroarch_version(cmd: List[str]) -> Optional[str]:
    if not cmd:
        return None
    key = "\0".join(cmd)
    if key not in _version_cache:
        version = None
        try:
            out = subprocess.run(
                cmd + ["--version"], capture_output=True, text=True, timeout=15
            )
            m = re.search(r"v?(\d+\.\d+\.\d+)", (out.stdout or "") + (out.stderr or ""))
            version = m.group(1) if m else None
        except (OSError, subprocess.SubprocessError):
            version = None
        _version_cache[key] = version
    return _version_cache[key]


class Library:
    def __init__(
        self,
        roms_dir: Path,
        cores_dir: Path,
        cache_path: Optional[Path] = None,
        nickname: str = "",
        retroarch_cmd: Optional[List[str]] = None,
        platform_tag: Optional[str] = None,
    ):
        self.roms_dir = Path(roms_dir)
        self.cores_dir = Path(cores_dir)
        self.cache = HashCache(cache_path)
        self.nickname = nickname
        self.retroarch_cmd = retroarch_cmd or []
        self.platform_tag = platform_tag or platforms.platform_tag()

    def scan_roms(self) -> List[dict]:
        roms = []
        if not self.roms_dir.is_dir():
            return roms
        for root, dirs, files in os.walk(self.roms_dir):
            dirs[:] = sorted(d for d in dirs if not d.startswith("."))
            for name in sorted(files):
                path = Path(root) / name
                if not path.is_file() or not is_content_file(path):
                    continue
                rel = path.relative_to(self.roms_dir).as_posix()
                roms.append(
                    {"path": rel, "size": path.stat().st_size, **self.cache.get(path)}
                )
        self.cache.save()
        return roms

    def scan_cores(self) -> List[dict]:
        cores = []
        if not self.cores_dir.is_dir():
            return cores
        for path in sorted(self.cores_dir.iterdir()):
            name = platforms.core_name_from_file(path.name)
            if not name or not path.is_file():
                continue
            digests = self.cache.get(path)
            cores.append(
                {
                    "name": name,
                    "file": path.name,
                    "size": path.stat().st_size,
                    "sha256": digests["sha256"],
                }
            )
        self.cache.save()
        return cores

    def manifest(self) -> dict:
        return {
            "version": MANIFEST_VERSION,
            "nickname": self.nickname,
            "platform": self.platform_tag,
            "retroarch_version": retroarch_version(self.retroarch_cmd),
            "roms": self.scan_roms(),
            "cores": self.scan_cores(),
        }

    def rom_path(self, entry: dict) -> Path:
        return self.roms_dir.joinpath(*safe_relpath(entry["path"]).parts)

    def core_path(self, entry: dict) -> Path:
        return self.cores_dir / entry["file"]

    def find_rom_by_sha(self, sha256: str) -> Optional[dict]:
        for rom in self.scan_roms():
            if rom["sha256"] == sha256:
                return rom
        return None

    def find_core(self, name: str) -> Optional[dict]:
        for core in self.scan_cores():
            if core["name"] == name:
                return core
        return None
