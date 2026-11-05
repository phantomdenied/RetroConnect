"""Guest side: make the local core + ROM identical to the host's.

Rules:
* ROMs are matched by SHA-256. If you already have the exact file anywhere in
  your ROM folder it's used as-is (name doesn't matter). Otherwise it's
  downloaded from the host to the same relative path the host uses.
* Cores on the same OS/CPU are matched by SHA-256 and downloaded from the
  host when missing or different, so both sides run the identical build.
* Cores across different OSes can't be copied (they're native binaries). The
  same core is fetched from the libretro buildbot instead, with a warning,
  since its version may not match the host's exactly.
* Anything replaced is kept as ``<name>.<timestamp>.old``, never deleted.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import socket
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import platforms
from .library import Library, retroarch_version, safe_relpath

ProgressFn = Callable[[str, int, int], None]
LogFn = Callable[[str], None]
CHUNK = 256 * 1024


class SyncError(Exception):
    pass


def _host_for_url(address: str) -> str:
    return f"[{address}]" if ":" in address and not address.startswith("[") else address


class HostClient:
    def __init__(self, address: str, port: int, secret: str, timeout: float = 30):
        if not address:
            raise SyncError(
                "peer_address isn't set. Run: retroconnect config set peer_address <buddy's IP>"
            )
        self.base = f"http://{_host_for_url(address)}:{port}"
        self.secret = secret
        self.timeout = timeout

    def open(self, path: str, headers: Optional[Dict[str, str]] = None):
        req = urllib.request.Request(self.base + path, headers=dict(headers or {}))
        req.add_header("Authorization", f"Bearer {self.secret}")
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.HTTPError as exc:
            if exc.code == 401:
                raise SyncError(
                    "host rejected the shared secret; make sure you both have the same one"
                ) from None
            raise
        except (urllib.error.URLError, socket.timeout, ConnectionError) as exc:
            reason = getattr(exc, "reason", exc)
            raise SyncError(
                f"can't reach the host at {self.base} ({reason}). Is `retroconnect host` "
                "or `retroconnect serve` running, and is the sync port reachable?"
            ) from None

    def get_json(self, path: str) -> dict:
        with self.open(path) as resp:
            return json.loads(resp.read().decode())

    def manifest(self) -> dict:
        return self.get_json("/api/manifest")

    def session(self) -> Optional[dict]:
        try:
            return self.get_json("/api/session")
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            raise


def backup_existing(path: Path) -> Optional[Path]:
    if not path.exists():
        return None
    backup = path.with_name(f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}.old")
    n = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}-{n}.old")
        n += 1
    os.replace(path, backup)
    return backup


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def download_from_host(
    client: HostClient,
    kind: str,
    sha256: str,
    size: int,
    dest: Path,
    label: str,
    progress: Optional[ProgressFn] = None,
) -> Optional[Path]:
    """Download into ``dest`` (resuming a ``.part`` file); returns any backup made."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    offset = part.stat().st_size if part.exists() else 0
    if offset > size:
        part.unlink()
        offset = 0

    if offset < size or size == 0:
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        try:
            resp = client.open(f"/files/{kind}/{sha256}", headers)
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise SyncError(f"host no longer has {label}; ask them to rescan") from None
            if exc.code != 416:
                raise SyncError(f"download of {label} failed: HTTP {exc.code}") from None
            resp = None  # already have every byte
        if resp is not None:
            with resp:
                if offset and resp.status != 206:
                    offset = 0  # server ignored the range; start over
                with open(part, "ab" if offset else "wb") as out:
                    done = offset
                    while True:
                        block = resp.read(CHUNK)
                        if not block:
                            break
                        out.write(block)
                        done += len(block)
                        if progress:
                            progress(label, done, size)

    if _sha256_file(part) != sha256:
        part.unlink()
        raise SyncError(f"{label} arrived corrupted (hash mismatch); try again")
    backup = backup_existing(dest)
    os.replace(part, dest)
    return backup


def fetch_core_from_buildbot(core_name: str, cores_dir: Path, log: LogFn) -> Path:
    url = platforms.buildbot_core_url(core_name)
    if not url:
        raise SyncError(
            f"no libretro buildbot download for {platforms.platform_tag()}; "
            f"install {core_name} with RetroArch's Online Updater"
        )
    fname = platforms.core_filename(core_name)
    log(f"Downloading {core_name} for {platforms.platform_tag()} from the libretro buildbot")
    try:
        with urllib.request.urlopen(url, timeout=120) as resp:
            data = resp.read()
    except (urllib.error.URLError, socket.timeout) as exc:
        raise SyncError(f"buildbot download failed: {getattr(exc, 'reason', exc)}") from None
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            member = next((n for n in zf.namelist() if n.rsplit("/", 1)[-1] == fname), None)
            if member is None:
                raise SyncError(f"buildbot archive didn't contain {fname}")
            payload = zf.read(member)
    except zipfile.BadZipFile:
        raise SyncError("buildbot returned a corrupt archive") from None
    cores_dir.mkdir(parents=True, exist_ok=True)
    dest = cores_dir / fname
    part = dest.with_name(fname + ".part")
    part.write_bytes(payload)
    backup_existing(dest)
    os.replace(part, dest)
    return dest


@dataclass
class SyncResult:
    rom_path: Optional[Path] = None
    core_path: Optional[Path] = None
    downloaded: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


class Syncer:
    def __init__(
        self,
        library: Library,
        client: HostClient,
        buildbot_fallback: bool = True,
        progress: Optional[ProgressFn] = None,
        log: LogFn = print,
    ):
        self.library = library
        self.client = client
        self.buildbot_fallback = buildbot_fallback
        self.progress = progress
        self.log = log

    # ----- single items --------------------------------------------------

    def ensure_rom(
        self, remote: dict, result: SyncResult, local_by_sha: Optional[Dict[str, dict]] = None
    ) -> Path:
        if local_by_sha is None:
            local_by_sha = {r["sha256"]: r for r in self.library.scan_roms()}
        local = local_by_sha.get(remote["sha256"])
        if local:
            return self.library.rom_path(local)
        dest = self.library.roms_dir.joinpath(*safe_relpath(remote["path"]).parts)
        why = "different version" if dest.exists() else "missing"
        self.log(f"ROM {remote['path']}: {why}, downloading from host")
        backup = download_from_host(
            self.client, "rom", remote["sha256"], remote["size"], dest,
            remote["path"], self.progress,
        )
        if backup:
            result.warnings.append(f"your old copy was kept as {backup.name}")
        result.downloaded.append(remote["path"])
        local_by_sha[remote["sha256"]] = {**remote}
        return dest

    def ensure_core(self, remote: dict, remote_platform: str, result: SyncResult) -> Path:
        name = remote["name"]
        local = self.library.find_core(name)
        if remote_platform == self.library.platform_tag:
            if local and local["sha256"] == remote["sha256"]:
                return self.library.core_path(local)
            why = "different build" if local else "missing"
            self.log(f"Core {name}: {why}, downloading host's copy")
            dest = self.library.cores_dir / remote["file"]
            backup = download_from_host(
                self.client, "core", remote["sha256"], remote["size"], dest,
                remote["file"], self.progress,
            )
            if backup:
                result.warnings.append(f"your previous {remote['file']} was kept as {backup.name}")
            result.downloaded.append(remote["file"])
            return dest

        # Different OS/CPU: the host's binary is useless to us.
        if local:
            result.warnings.append(
                f"host is on {remote_platform}, you're on {self.library.platform_tag}: using "
                f"your own {local['file']}. Make sure you're both on the same {name} version "
                "(Online Updater > Update Cores) or you may desync."
            )
            return self.library.core_path(local)
        if not self.buildbot_fallback:
            raise SyncError(
                f"you don't have {name}, and the host's copy is for {remote_platform}. "
                "Install it with RetroArch's Online Updater, or enable buildbot_fallback."
            )
        path = fetch_core_from_buildbot(name, self.library.cores_dir, self.log)
        result.downloaded.append(path.name)
        result.warnings.append(
            f"{name} came from the libretro nightly buildbot, since the host is on "
            f"{remote_platform}. If you desync, have you both update cores to the latest."
        )
        return path

    # ----- whole operations ----------------------------------------------

    def _version_warning(self, remote: dict, result: SyncResult) -> None:
        theirs = remote.get("retroarch_version")
        ours = retroarch_version(self.library.retroarch_cmd)
        if theirs and ours and theirs != ours:
            result.warnings.append(
                f"RetroArch versions differ (host {theirs}, you {ours}). "
                "Netplay works best on the same version."
            )

    def sync_session(self, session: dict) -> SyncResult:
        result = SyncResult()
        self._version_warning(session, result)
        result.core_path = self.ensure_core(session["core"], session["platform"], result)
        result.rom_path = self.ensure_rom(session["rom"], result)
        return result

    def sync_library(
        self, manifest: dict, query: Optional[str] = None, include_cores: bool = True
    ) -> SyncResult:
        result = SyncResult()
        local_by_sha = {r["sha256"]: r for r in self.library.scan_roms()}
        q = (query or "").lower()
        for rom in manifest["roms"]:
            if q and q not in rom["path"].lower():
                continue
            try:
                self.ensure_rom(rom, result, local_by_sha)
            except SyncError as exc:
                result.warnings.append(str(exc))
        if include_cores and manifest["platform"] == self.library.platform_tag:
            for core in manifest["cores"]:
                try:
                    self.ensure_core(core, manifest["platform"], result)
                except SyncError as exc:
                    result.warnings.append(str(exc))
        return result


def compare(local: dict, remote: dict) -> dict:
    """Which games/cores each side has, by content hash."""
    mine = {r["sha256"]: r for r in local["roms"]}
    theirs = {r["sha256"]: r for r in remote["roms"]}
    mine_by_path = {r["path"]: r for r in local["roms"]}
    mismatched = [
        r for sha, r in theirs.items()
        if sha not in mine and r["path"] in mine_by_path
    ]
    mismatched_paths = {r["path"] for r in mismatched}
    return {
        "both": sorted((theirs[s]["path"] for s in theirs.keys() & mine.keys())),
        "only_host": sorted(
            r["path"] for s, r in theirs.items()
            if s not in mine and r["path"] not in mismatched_paths
        ),
        "only_you": sorted(
            r["path"] for s, r in mine.items()
            if s not in theirs and r["path"] not in mismatched_paths
        ),
        "different_version": sorted(mismatched_paths),
    }
