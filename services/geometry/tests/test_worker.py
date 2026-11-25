"""Internal worker: signature, limits, isolation and the files it returns."""
import base64
import hashlib
import http.client
import json
import threading
import sys
import time

import pytest
from conftest import FIXTURES, REPO, load

from aurea_geometry.worker import Settings, WorkerServer, sign, verify

SECRET = "s" * 40


def settings(**kw):
    base = dict(secret=SECRET.encode(), host="127.0.0.1", port=0, timeout_s=60.0, memory_mb=0, concurrency=2)
    return Settings(**(base | kw))


@pytest.fixture(scope="module")
def server():
    srv = WorkerServer(settings())
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield srv
    srv.shutdown()
    srv.server_close()


def post(srv, body: bytes, signature: str | None = "auto", path="/v1/regenerate"):
    conn = http.client.HTTPConnection(*srv.server_address, timeout=120)
    headers = {"Content-Type": "application/json"}
    if signature == "auto":
        signature = sign(SECRET.encode(), "POST", path, body)
    if signature:
        headers["X-Aurea-Signature"] = signature
    conn.request("POST", path, body=body, headers=headers)
    res = conn.getresponse()
    return res.status, json.loads(res.read() or b"{}")


def job(document):
    return json.dumps({"jobId": "6f1c0c64-55a5-4d2b-9a3a-3d6c5f0e8a11", "document": document}).encode()


def ring():
    return load(REPO / "09_JEWELRY_ENGINE" / "fixtures" / "ring.json")


def test_refuses_to_start_without_secret():
    with pytest.raises(SystemExit):
        Settings.from_env({})
    with pytest.raises(SystemExit):
        Settings.from_env({"GEOMETRY_WORKER_SECRET": "short"})


def test_signature_checks():
    body = b"{}"
    s = sign(b"k" * 32, "POST", "/v1/regenerate", body)
    assert verify(b"k" * 32, s, "POST", "/v1/regenerate", body)
    assert not verify(b"k" * 32, s, "POST", "/v1/regenerate", b"{ }")  # body changed
    assert not verify(b"x" * 32, s, "POST", "/v1/regenerate", body)  # other key
    assert not verify(b"k" * 32, s, "POST", "/other", body)  # other path
    old = sign(b"k" * 32, "POST", "/v1/regenerate", body, int(time.time()) - 301)
    assert not verify(b"k" * 32, old, "POST", "/v1/regenerate", body)  # stale
    assert not verify(b"k" * 32, None, "POST", "/v1/regenerate", body)
    assert not verify(b"k" * 32, "garbage", "POST", "/v1/regenerate", body)


def test_health_needs_no_signature(server):
    conn = http.client.HTTPConnection(*server.server_address)
    conn.request("GET", "/healthz")
    assert conn.getresponse().status == 200


@pytest.mark.parametrize("sig", [None, "t=1,v1=00"])
def test_unsigned_or_badly_signed_requests_are_rejected(server, sig):
    status, body = post(server, job(ring()), sig)
    assert (status, body["code"]) == (401, "UNAUTHENTICATED")


def test_oversized_body_is_rejected_before_reading(server):
    conn = http.client.HTTPConnection(*server.server_address)
    conn.putrequest("POST", "/v1/regenerate")
    conn.putheader("Content-Length", str(2_000_000))
    conn.endheaders()
    assert conn.getresponse().status == 413


def test_malformed_request_is_400(server):
    status, body = post(server, json.dumps({"jobId": "not-a-uuid", "document": {}}).encode())
    assert (status, body["code"]) == (400, "INVALID_REQUEST")


def test_invalid_document_is_rejected_with_codes(server):
    case = load(FIXTURES / "invalid_cases.json")["out_of_range"]
    status, body = post(server, job(case["document"]))
    assert status == 422 and body["code"] == "INVALID_DOCUMENT"
    assert [d["code"] for d in body["details"]] == ["OUT_OF_RANGE"]


def test_regenerate_returns_hashed_files(server):
    status, body = post(server, job(ring()))
    assert status == 200
    kinds = sorted(f["kind"] for f in body["files"])
    assert kinds == ["DFM_REPORT", "GLB_PREVIEW", "MANIFEST", "STEP", "STL"]
    for f in body["files"]:
        data = base64.b64decode(f["contentBase64"])
        assert hashlib.sha256(data).hexdigest() == f["sha256"] and len(data) == f["bytes"]
    units = {f["kind"]: f["units"] for f in body["files"]}
    assert (units["STEP"], units["STL"], units["GLB_PREVIEW"]) == ("mm", "mm", "m")
    assert body["manifest"]["dfm"]["humanApprovalRequired"] is True


def test_timeout_kills_the_job():
    srv = WorkerServer(settings(timeout_s=0.01))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        status, body = post(srv, job(ring()))
        assert (status, body["code"]) == (504, "GEOMETRY_TIMEOUT")
    finally:
        srv.shutdown()
        srv.server_close()


def test_busy_worker_answers_503():
    srv = WorkerServer(settings(concurrency=1))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    srv.slots.acquire()
    try:
        status, body = post(srv, job(ring()))
        assert (status, body["code"]) == (503, "SERVICE_UNAVAILABLE")
    finally:
        srv.slots.release()
        srv.shutdown()
        srv.server_close()


def test_default_memory_limit_still_builds():
    srv = WorkerServer(settings(memory_mb=2048))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        assert post(srv, job(ring()))[0] == 200
    finally:
        srv.shutdown()
        srv.server_close()


# The memory cap uses resource.setrlimit (POSIX). On Windows only the wall-clock timeout applies,
# as the README says, so there is nothing to test there; production workers run on Linux.
@pytest.mark.skipif(sys.platform == "win32", reason="no RLIMIT_AS on Windows; only the timeout applies")
def test_job_that_exceeds_memory_fails_without_details():
    srv = WorkerServer(settings(memory_mb=64))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        status, body = post(srv, job(ring()))
        assert (status, body["code"], body["details"]) == (500, "GEOMETRY_FAILED", [])
    finally:
        srv.shutdown()
        srv.server_close()


def test_withheld_body_times_out_before_any_signature_check():
    srv = WorkerServer(settings(read_timeout_s=0.3))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        conn = http.client.HTTPConnection(*srv.server_address, timeout=10)
        conn.putrequest("POST", "/v1/regenerate")
        conn.putheader("Content-Length", "100")
        conn.endheaders()
        conn.send(b"{")  # announces 100 bytes, sends 1, then stalls
        started = time.monotonic()
        res = conn.getresponse()
        assert res.status == 408
        assert json.loads(res.read())["code"] == "INVALID_REQUEST"
        assert time.monotonic() - started < 5
    finally:
        srv.shutdown()
        srv.server_close()


def test_connections_over_the_cap_are_closed_without_a_thread():
    import socket

    srv = WorkerServer(settings(read_timeout_s=5, max_connections=1))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        idle = socket.create_connection(srv.server_address)  # holds the only slot
        time.sleep(0.2)
        extra = socket.create_connection(srv.server_address)
        extra.settimeout(3)
        assert extra.recv(1) == b"", "over-cap connection is closed at once"
        extra.close()
        idle.close()
        time.sleep(0.2)
        conn = http.client.HTTPConnection(*srv.server_address, timeout=10)
        conn.request("GET", "/healthz")
        assert conn.getresponse().status == 200, "the slot is released when a connection ends"
    finally:
        srv.shutdown()
        srv.server_close()
