"""Mesh provider adapter contract (12_AI_ORCHESTRATION/AI_ARCHITECTURE.md).

Each adapter implements generate, poll, cancel, normalize, estimate_cost, health
and capabilities. Jobs are asynchronous and idempotent per request key: repeating
a request never creates a second job or a second charge.
"""
from __future__ import annotations

import enum
import hashlib
import json
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Protocol

_KEY = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{7,127}")
_SHA = re.compile(r"[0-9a-f]{64}")
MAX_PROMPT_CHARS = 2000
MAX_ATTACHMENTS = 4


class MeshAdapterError(Exception):
    """Base error. `code` is stable and safe to show; messages carry no PII."""

    code = "MESH_ERROR"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class InvalidRequest(MeshAdapterError):
    code = "INVALID_REQUEST"


class IdempotencyConflict(MeshAdapterError):
    code = "IDEMPOTENCY_CONFLICT"


class UnknownJob(MeshAdapterError):
    code = "UNKNOWN_JOB"


class ProviderNotConfigured(MeshAdapterError):
    code = "PROVIDER_NOT_CONFIGURED"


class JobState(str, enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

    @property
    def terminal(self) -> bool:
        return self in (JobState.SUCCEEDED, JobState.FAILED, JobState.CANCELLED)


@dataclass(frozen=True)
class MeshRequest:
    """What the gateway sends after ACL, consent and quota checks.

    Attachments travel as content digests only; the adapter never sees customer
    files it does not need, and never another customer's.
    """

    idempotency_key: str
    project_id: str
    revision_id: str
    prompt: str
    attachment_sha256: tuple[str, ...] = ()

    def validate(self) -> None:
        if not _KEY.fullmatch(self.idempotency_key):
            raise InvalidRequest("idempotency_key must be 8-128 chars of [A-Za-z0-9._:-]")
        for name in ("project_id", "revision_id"):
            if not _KEY.fullmatch(getattr(self, name)):
                raise InvalidRequest(f"{name} has an invalid format")
        if not self.prompt.strip():
            raise InvalidRequest("prompt is empty")
        if len(self.prompt) > MAX_PROMPT_CHARS:
            raise InvalidRequest(f"prompt exceeds {MAX_PROMPT_CHARS} characters")
        if len(self.attachment_sha256) > MAX_ATTACHMENTS:
            raise InvalidRequest(f"at most {MAX_ATTACHMENTS} attachments")
        for digest in self.attachment_sha256:
            if not _SHA.fullmatch(digest):
                raise InvalidRequest("attachment digest must be lowercase SHA-256 hex")

    def fingerprint(self) -> str:
        payload = {
            "project_id": self.project_id,
            "revision_id": self.revision_id,
            "prompt": self.prompt,
            "attachment_sha256": list(self.attachment_sha256),
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


@dataclass(frozen=True)
class CostEstimate:
    amount: Decimal
    currency: str | None  # None when the unit is not money (simulator)
    unit: str


@dataclass(frozen=True)
class ProviderRecord:
    """Capability registry entry. Unknown commercial terms stay None, never assumed."""

    provider: str
    model_id: str
    version: str
    modalities_in: tuple[str, ...]
    modalities_out: tuple[str, ...]
    max_prompt_chars: int
    max_attachments: int
    region: str | None
    retention: str | None
    commercial_rights: str | None
    price_unit: str
    fallback_eligible: bool
    simulated: bool


@dataclass
class JobStatus:
    job_id: str
    state: JobState
    simulated: bool
    progress: float = 0.0
    error_code: str | None = None
    result_format: str | None = None  # e.g. "glb" once SUCCEEDED
    notes: list[str] = field(default_factory=list)


class MeshAdapter(Protocol):
    def capabilities(self) -> ProviderRecord: ...
    def health(self) -> dict: ...
    def estimate_cost(self, request: MeshRequest) -> CostEstimate: ...
    def generate(self, request: MeshRequest) -> JobStatus: ...
    def poll(self, job_id: str) -> JobStatus: ...
    def cancel(self, job_id: str) -> JobStatus: ...
    def result(self, job_id: str) -> bytes: ...
