"""Internal geometry worker: signed HTTP requests in, BREP artifacts out.

Only the API talks to this process (ARCHITECTURE.md: API -> job -> worker
receives the snapshot). It is stateless: the API persists jobs, stores the
returned files by SHA-256 and decides what a result means. Every request
except /healthz must carry an HMAC-SHA256 signature made with
GEOMETRY_WORKER_SECRET; without the secret the worker refuses to start
(fail closed).

Each regeneration runs in a child process with a wall-clock timeout (and CPU
and memory limits where the OS supports them), so a pathological document
cannot hang or exhaust the worker. Documents are validated again here even
though the API already validated them.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import multiprocessing as mp
import os
import shutil
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import ENGINE_VERSION

MAX_BODY_BYTES = 1_000_000
SIGNATURE_HEADER = "X-Aurea-Signature"
SIGNATURE_MAX_SKEW_S = 300
MIN_SECRET_LEN = 32

# Artifact kinds of the OpenAPI JobArtifact schema.
KIND_BY_SUFFIX = {".step": ("STEP", "mm"), ".stl": ("STL", "mm"), ".glb": ("GLB_PREVIEW", "m")}


@dataclass(frozen=True)
class Settings:
    secret: bytes
    host: str
    port: int
    timeout_s: float
    memory_mb: int
    concurrency: int
    # Socket deadline for reading a request (headers and body). Bounds clients that announce a
    # body and never send it, which would otherwise hold a thread before any signature check.
    read_timeout_s: float = 10.0
    max_connections: int = 32

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        secret = env.get("GEOMETRY_WORKER_SECRET", "")
        if len(secret) < MIN_SECRET_LEN:
            raise SystemExit(f"GEOMETRY_WORKER_SECRET must be set (>= {MIN_SECRET_LEN} chars); refusing to start")
        return Settings(
            secret=secret.encode("utf-8"),
            host=env.get("GEOMETRY_WORKER_HOST", "127.0.0.1"),
            port=int(env.get("GEOMETRY_WORKER_PORT", "3910")),
            timeout_s=float(env.get("GEOMETRY_JOB_TIMEOUT_S", "60")),
            memory_mb=int(env.get("GEOMETRY_JOB_MEMORY_MB", "2048")),
            concurrency=int(env.get("GEOMETRY_WORKER_CONCURRENCY", "2")),
            read_timeout_s=float(env.get("GEOMETRY_READ_TIMEOUT_S", "10")),
            max_connections=int(env.get("GEOMETRY_MAX_CONNECTIONS", "32")),
        )


def sign(secret: bytes, method: str, path: str, body: bytes, timestamp: int | None = None) -> str:
    """Header value `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.METHOD.path." + body>`."""
    t = int(time.time()) if timestamp is None else timestamp
    mac = hmac.new(secret, f"{t}.{method}.{path}.".encode("utf-8") + body, hashlib.sha256).hexdigest()
    return f"t={t},v1={mac}"


def verify(secret: bytes, header: str | None, method: str, path: str, body: bytes, now: float | None = None) -> bool:
    if not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    now = time.time() if now is None else now
    if abs(now - t) > SIGNATURE_MAX_SKEW_S:
        return False
    expected = sign(secret, method, path, body, t).split("v1=", 1)[1]
    return hmac.compare_digest(expected, parts.get("v1", ""))


# --- child process ---------------------------------------------------------

def _limit_resources(timeout_s: float, memory_mb: int) -> None:
    try:
        import resource
    except ImportError:  # Windows: only the wall-clock timeout applies
        return
    cpu = int(timeout_s) + 5
    resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
    if memory_mb > 0:
        limit = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (limit, limit))


def _run_job(document: dict, out_dir: str, timeout_s: float, memory_mb: int, conn) -> None:
    try:
        _limit_resources(timeout_s, memory_mb)
        from .document import InvalidDocument
        from .pipeline import regenerate

        try:
            manifest = regenerate(document, Path(out_dir))
        except InvalidDocument as e:
            conn.send(("invalid", [i.__dict__ for i in e.issues]))
            return
        conn.send(("ok", manifest))
    except BaseException as e:  # noqa: BLE001 - report the class only, never the document
        conn.send(("error", type(e).__name__))
    finally:
        conn.close()


def _context():
    methods = mp.get_all_start_methods()
    if "forkserver" in methods:
        ctx = mp.get_context("forkserver")
        # The fork server imports the CAD kernel once; each job forks from it.
        ctx.set_forkserver_preload(["aurea_geometry.pipeline"])
        return ctx
    return mp.get_context("spawn")


class JobOutcome(Exception):
    def __init__(self, status: HTTPStatus, code: str, details: list | None = None):
        self.status, self.code, self.details = status, code, details or []
        super().__init__(code)


def regenerate_isolated(document: dict, settings: Settings, ctx=None) -> dict:
    """Run regenerate() in a child process; return manifest + files (base64)."""
    ctx = ctx or _context()
    out_dir = tempfile.mkdtemp(prefix="aurea-geom-")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_run_job, args=(document, out_dir, settings.timeout_s, settings.memory_mb, child))
    try:
        proc.start()
        child.close()
        if not parent.poll(settings.timeout_s):
            raise JobOutcome(HTTPStatus.GATEWAY_TIMEOUT, code="GEOMETRY_TIMEOUT")
        try:
            status, payload = parent.recv()
        except EOFError:  # child died (memory or CPU limit, crash) without reporting
            raise JobOutcome(HTTPStatus.INTERNAL_SERVER_ERROR, code="GEOMETRY_FAILED") from None
        if status == "invalid":
            raise JobOutcome(HTTPStatus.UNPROCESSABLE_ENTITY, code="INVALID_DOCUMENT", details=payload)
        if status != "ok":
            raise JobOutcome(HTTPStatus.INTERNAL_SERVER_ERROR, code="GEOMETRY_FAILED")
        return _collect(payload, Path(out_dir))
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(5)
        parent.close()
        shutil.rmtree(out_dir, ignore_errors=True)


def _file_entry(name: str, kind: str, units: str, data: bytes) -> dict:
    return {
        "name": name,
        "kind": kind,
        "units": units,
        "sha256": hashlib.sha256(data).hexdigest(),
        "bytes": len(data),
        "contentBase64": base64.b64encode(data).decode("ascii"),
    }


def _collect(manifest: dict, out_dir: Path) -> dict:
    files = []
    for comp in manifest["components"]:
        for art in comp["artifacts"]:
            path = out_dir / art["file"]
            data = path.read_bytes()
            kind, units = KIND_BY_SUFFIX[path.suffix]
            if hashlib.sha256(data).hexdigest() != art["sha256"]:
                raise JobOutcome(HTTPStatus.INTERNAL_SERVER_ERROR, code="GEOMETRY_FAILED")
            files.append(_file_entry(art["file"], kind, units, data))
    dfm = json.dumps(manifest["dfm"], indent=2, sort_keys=True).encode("utf-8")
    files.append(_file_entry("dfm.json", "DFM_REPORT", "none", dfm))
    files.append(_file_entry("manifest.json", "MANIFEST", "none", (out_dir / "manifest.json").read_bytes()))
    return {"manifest": manifest, "files": files}


# --- HTTP ------------------------------------------------------------------

class WorkerServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, settings: Settings, ctx=None):
        self.settings = settings
        self.ctx = ctx or _context()
        self.slots = threading.BoundedSemaphore(settings.concurrency)
        self.connections = threading.BoundedSemaphore(settings.max_connections)
        super().__init__((settings.host, settings.port), Handler)

    def process_request(self, request, client_address):
        # Connections beyond the cap are closed at once instead of each taking a thread.
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connections.release()


class Handler(BaseHTTPRequestHandler):
    server: WorkerServer
    server_version = "aurea-geometry"
    sys_version = ""

    def setup(self):
        self.timeout = self.server.settings.read_timeout_s  # StreamRequestHandler applies it to the socket
        super().setup()

    def log_message(self, fmt, *args):  # access log without bodies or PII
        sys.stderr.write(f"{self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

    def _send(self, status: HTTPStatus, body: dict, headers: dict | None = None) -> None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: HTTPStatus, code: str, details: list | None = None, headers: dict | None = None):
        self._send(status, {"code": code, "details": details or []}, headers)

    def do_GET(self):
        if self.path == "/healthz":
            self._send(HTTPStatus.OK, {"status": "ok", "engineVersion": ENGINE_VERSION})
        else:
            self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")

    def do_POST(self):
        if self.path != "/v1/regenerate":
            return self._error(HTTPStatus.NOT_FOUND, "NOT_FOUND")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            return self._error(HTTPStatus.LENGTH_REQUIRED, "INVALID_REQUEST")
        if length < 0 or length > MAX_BODY_BYTES:
            return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "INVALID_REQUEST")
        try:
            body = self.rfile.read(length)
        except TimeoutError:
            self.close_connection = True
            return self._error(HTTPStatus.REQUEST_TIMEOUT, "INVALID_REQUEST")
        if len(body) != length:  # client closed before sending the announced body
            self.close_connection = True
            return self._error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST")
        if not verify(self.server.settings.secret, self.headers.get(SIGNATURE_HEADER), "POST", self.path, body):
            return self._error(HTTPStatus.UNAUTHORIZED, "UNAUTHENTICATED")
        try:
            req = json.loads(body)
            uuid.UUID(req["jobId"])
            document = req["document"]
            if not isinstance(document, dict):
                raise TypeError
        except (ValueError, KeyError, TypeError):
            return self._error(HTTPStatus.BAD_REQUEST, "INVALID_REQUEST")
        if not self.server.slots.acquire(blocking=False):
            return self._error(HTTPStatus.SERVICE_UNAVAILABLE, "SERVICE_UNAVAILABLE", headers={"Retry-After": "2"})
        try:
            result = regenerate_isolated(document, self.server.settings, self.server.ctx)
        except JobOutcome as e:
            return self._error(e.status, e.code, e.details)
        finally:
            self.server.slots.release()
        self._send(HTTPStatus.OK, {"jobId": req["jobId"], **result})


def main(argv: list[str] | None = None) -> int:
    settings = Settings.from_env()
    server = WorkerServer(settings)
    sys.stderr.write(f"aurea-geometry worker on {settings.host}:{settings.port}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
