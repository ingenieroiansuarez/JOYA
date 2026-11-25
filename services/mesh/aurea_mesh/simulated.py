"""Simulated mesh provider: deterministic fixture output with a SIMULATED banner.

State lives in memory; a production adapter persists jobs in the job table so a
restart neither loses nor duplicates them.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from decimal import Decimal

from .adapter import (
    CostEstimate,
    IdempotencyConflict,
    InvalidRequest,
    JobState,
    JobStatus,
    MAX_ATTACHMENTS,
    MAX_PROMPT_CHARS,
    MeshRequest,
    ProviderRecord,
    UnknownJob,
)
from .fixture import FIXTURE_ID, fixture_glb

SIMULATED_BANNER = "SIMULADO: malla de ejemplo, no generada por un proveedor"
POLLS_TO_FINISH = 3  # QUEUED -> RUNNING -> RUNNING -> SUCCEEDED


@dataclass
class _Job:
    status: JobStatus
    fingerprint: str
    polls: int = 0


class SimulatedMeshAdapter:
    def __init__(self, fail_prompts: frozenset[str] = frozenset()):
        # Prompts listed here end in FAILED, to exercise the provider-error path.
        self._fail_prompts = fail_prompts
        self._jobs: dict[str, _Job] = {}
        self._by_key: dict[str, str] = {}
        self._prompts: dict[str, str] = {}
        self.generate_calls_charged = 0

    def capabilities(self) -> ProviderRecord:
        return ProviderRecord(
            provider="simulated",
            model_id=FIXTURE_ID,
            version="1",
            modalities_in=("text", "image"),
            modalities_out=("mesh/glb",),
            max_prompt_chars=MAX_PROMPT_CHARS,
            max_attachments=MAX_ATTACHMENTS,
            region="local",
            retention="none",
            commercial_rights=None,
            price_unit="SIMULATED_JOB",
            fallback_eligible=False,
            simulated=True,
        )

    def health(self) -> dict:
        return {"ok": True, "simulated": True, "banner": SIMULATED_BANNER}

    def estimate_cost(self, request: MeshRequest) -> CostEstimate:
        request.validate()
        return CostEstimate(amount=Decimal("0"), currency=None, unit="SIMULATED_JOB")

    def generate(self, request: MeshRequest) -> JobStatus:
        request.validate()
        fp = request.fingerprint()
        existing = self._by_key.get(request.idempotency_key)
        if existing is not None:
            job = self._jobs[existing]
            if job.fingerprint != fp:
                raise IdempotencyConflict("idempotency key reused with a different request")
            return self._copy(job.status)
        job_id = "simjob_" + hashlib.sha256(request.idempotency_key.encode()).hexdigest()[:24]
        status = JobStatus(job_id=job_id, state=JobState.QUEUED, simulated=True, notes=[SIMULATED_BANNER])
        self._jobs[job_id] = _Job(status=status, fingerprint=fp)
        self._by_key[request.idempotency_key] = job_id
        self._prompts[job_id] = request.prompt
        self.generate_calls_charged += 1
        return self._copy(status)

    def poll(self, job_id: str) -> JobStatus:
        job = self._get(job_id)
        st = job.status
        if not st.state.terminal:
            job.polls += 1
            if job.polls >= POLLS_TO_FINISH:
                if self._prompts.get(job_id) in self._fail_prompts:
                    st.state, st.error_code, st.progress = JobState.FAILED, "PROVIDER_FAILED", 1.0
                else:
                    st.state, st.progress, st.result_format = JobState.SUCCEEDED, 1.0, "glb"
            else:
                st.state, st.progress = JobState.RUNNING, job.polls / POLLS_TO_FINISH
        return self._copy(st)

    def cancel(self, job_id: str) -> JobStatus:
        job = self._get(job_id)
        if not job.status.state.terminal:
            job.status.state = JobState.CANCELLED
        return self._copy(job.status)

    def result(self, job_id: str) -> bytes:
        job = self._get(job_id)
        if job.status.state is not JobState.SUCCEEDED:
            raise InvalidRequest(f"job is {job.status.state.value}, no result", code="RESULT_NOT_READY")
        return fixture_glb()

    def _get(self, job_id: str) -> _Job:
        try:
            return self._jobs[job_id]
        except KeyError:
            raise UnknownJob("unknown job id") from None

    @staticmethod
    def _copy(st: JobStatus) -> JobStatus:
        return JobStatus(**{**st.__dict__, "notes": list(st.notes)})
