"""The host's sync server: tells the guest what's being played and serves the
exact core and ROM files so both sides match.

Endpoints (all require ``Authorization: Bearer <shared_secret>``):

    GET /api/manifest          host's ROM + core library
    GET /api/session           what the host is launching right now (404 if idle)
    GET /files/rom/<sha256>    a ROM, by content hash
    GET /files/core/<sha256>   a core, by content hash

Files are only ever looked up by hash from the host's own scan, so a guest
can't ask for arbitrary paths. ``Range: bytes=N-`` is honoured so interrupted
downloads resume.
"""

from __future__ import annotations

import hmac
import json
import re
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional, Tuple

from . import __version__
from .library import Library

_FILE_ROUTE = re.compile(r"^/files/(rom|core)/([0-9a-f]{64})$")
_RANGE = re.compile(r"^bytes=(\d+)-$")
COPY_CHUNK = 256 * 1024


class SyncState:
    def __init__(self, library: Library, secret: str):
        if not secret:
            raise ValueError("a shared_secret is required to run the sync server")
        self.library = library
        self.secret = secret
        self.session: Optional[dict] = None
        self._lock = threading.Lock()
        self._manifest: Optional[dict] = None
        self._index: Dict[Tuple[str, str], Path] = {}

    def manifest(self) -> dict:
        """Rescan (cheap thanks to the hash cache) and rebuild the file index."""
        with self._lock:
            manifest = self.library.manifest()
            index: Dict[Tuple[str, str], Path] = {}
            for rom in manifest["roms"]:
                index[("rom", rom["sha256"])] = self.library.rom_path(rom)
            for core in manifest["cores"]:
                index[("core", core["sha256"])] = self.library.core_path(core)
            self._manifest, self._index = manifest, index
            return manifest

    def lookup(self, kind: str, sha256: str) -> Optional[Path]:
        with self._lock:
            have_index = self._manifest is not None
            path = self._index.get((kind, sha256))
        if path is None and not have_index:
            self.manifest()
            with self._lock:
                path = self._index.get((kind, sha256))
        return path


class _Handler(BaseHTTPRequestHandler):
    server_version = f"RetroConnect/{__version__}"
    state: SyncState  # set on the subclass created by SyncServer

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = f"Bearer {self.state.secret}"
        return hmac.compare_digest(header.encode(), expected.encode())

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (http.server naming)
        if not self._authorized():
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "bad or missing shared secret"})
            return
        path = self.path.split("?", 1)[0]
        if path == "/api/manifest":
            self._json(HTTPStatus.OK, self.state.manifest())
        elif path == "/api/session":
            session = self.state.session
            if session is None:
                self._json(HTTPStatus.NOT_FOUND, {"error": "host isn't running a game"})
            else:
                self._json(HTTPStatus.OK, session)
        elif _FILE_ROUTE.match(path):
            kind, sha = _FILE_ROUTE.match(path).groups()
            self._send_file(kind, sha)
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def _send_file(self, kind: str, sha: str) -> None:
        file_path = self.state.lookup(kind, sha)
        if file_path is None or not file_path.is_file():
            self._json(HTTPStatus.NOT_FOUND, {"error": f"host doesn't have that {kind}"})
            return
        size = file_path.stat().st_size
        start = 0
        rng = _RANGE.match(self.headers.get("Range", ""))
        if rng:
            start = int(rng.group(1))
            if start >= size:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        with open(file_path, "rb") as fh:
            fh.seek(start)
            if rng:
                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
            else:
                self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(size - start))
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            try:
                while True:
                    block = fh.read(COPY_CHUNK)
                    if not block:
                        break
                    self.wfile.write(block)
            except (BrokenPipeError, ConnectionResetError):
                pass  # guest cancelled; they'll resume next time


class SyncServer:
    def __init__(self, state: SyncState, bind: str = "0.0.0.0", port: int = 55440):
        handler = type("Handler", (_Handler,), {"state": state})
        self.state = state
        self.httpd = ThreadingHTTPServer((bind, port), handler)
        self.httpd.daemon_threads = True
        self._thread: Optional[threading.Thread] = None

    @property
    def port(self) -> int:
        return self.httpd.server_address[1]

    def start(self) -> "SyncServer":
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self._thread.start()
        return self

    def serve_forever(self) -> None:
        self.httpd.serve_forever()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        if self._thread:
            self._thread.join(timeout=5)
