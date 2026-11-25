from decimal import Decimal

import pytest

from aurea_mesh.adapter import (
    IdempotencyConflict,
    InvalidRequest,
    JobState,
    MeshRequest,
    ProviderNotConfigured,
    UnknownJob,
)
from aurea_mesh.registry import build_adapter
from aurea_mesh.simulated import SIMULATED_BANNER, SimulatedMeshAdapter


def req(key="req-0000001", prompt="anillo toroide", **kw):
    return MeshRequest(idempotency_key=key, project_id="prj_00000001", revision_id="rev_00000001", prompt=prompt, **kw)


def run(adapter, job):
    while not job.state.terminal:
        job = adapter.poll(job.job_id)
    return job


def test_happy_path_is_simulated_and_free():
    a = SimulatedMeshAdapter()
    job = a.generate(req())
    assert job.state is JobState.QUEUED and job.simulated and SIMULATED_BANNER in job.notes
    states = [a.poll(job.job_id).state for _ in range(3)]
    assert states == [JobState.RUNNING, JobState.RUNNING, JobState.SUCCEEDED]
    assert a.result(job.job_id)[:4] == b"glTF"
    cost = a.estimate_cost(req())
    assert cost.amount == Decimal("0") and cost.currency is None and cost.unit == "SIMULATED_JOB"
    cap = a.capabilities()
    assert cap.simulated and cap.commercial_rights is None and not cap.fallback_eligible


def test_same_key_same_request_returns_same_job_without_new_charge():
    a = SimulatedMeshAdapter()
    j1 = a.generate(req())
    j2 = a.generate(req())
    assert j1.job_id == j2.job_id and a.generate_calls_charged == 1


def test_same_key_different_request_is_rejected():
    a = SimulatedMeshAdapter()
    a.generate(req())
    with pytest.raises(IdempotencyConflict):
        a.generate(req(prompt="otro diseño"))


def test_cancel_before_finish_and_cancel_is_idempotent():
    a = SimulatedMeshAdapter()
    job = a.generate(req())
    a.poll(job.job_id)
    assert a.cancel(job.job_id).state is JobState.CANCELLED
    assert a.cancel(job.job_id).state is JobState.CANCELLED
    assert a.poll(job.job_id).state is JobState.CANCELLED
    with pytest.raises(InvalidRequest) as e:
        a.result(job.job_id)
    assert e.value.code == "RESULT_NOT_READY"


def test_cancel_after_success_does_not_undo_it():
    a = SimulatedMeshAdapter()
    job = run(a, a.generate(req()))
    assert a.cancel(job.job_id).state is JobState.SUCCEEDED


def test_retry_after_cancel_needs_new_key_and_creates_one_new_job():
    a = SimulatedMeshAdapter()
    j1 = a.generate(req())
    a.cancel(j1.job_id)
    assert a.generate(req()).state is JobState.CANCELLED  # same key: same (cancelled) job, no duplicate
    j2 = run(a, a.generate(req(key="req-0000002")))
    assert j2.job_id != j1.job_id and j2.state is JobState.SUCCEEDED and a.generate_calls_charged == 2


def test_provider_failure_path():
    a = SimulatedMeshAdapter(fail_prompts=frozenset({"falla"}))
    job = run(a, a.generate(req(prompt="falla")))
    assert job.state is JobState.FAILED and job.error_code == "PROVIDER_FAILED"


def test_returned_status_is_a_copy():
    a = SimulatedMeshAdapter()
    job = a.generate(req())
    job.state = JobState.SUCCEEDED
    with pytest.raises(InvalidRequest):
        a.result(job.job_id)


@pytest.mark.parametrize(
    "kw",
    [
        {"key": "short"},
        {"key": "has space 123"},
        {"prompt": "   "},
        {"prompt": "x" * 2001},
        {"attachment_sha256": ("NOTHEX",)},
        {"attachment_sha256": tuple("a" * 64 for _ in range(5))},
    ],
)
def test_invalid_requests(kw):
    with pytest.raises(InvalidRequest):
        SimulatedMeshAdapter().generate(req(**kw))


def test_unknown_job():
    with pytest.raises(UnknownJob):
        SimulatedMeshAdapter().poll("simjob_missing")


def test_registry_fails_closed():
    assert build_adapter("simulated", "demo").capabilities().simulated
    with pytest.raises(ProviderNotConfigured):
        build_adapter("simulated", "production")
    for provider in ("meshy", "tripo", ""):
        for env in ("demo", "production"):
            with pytest.raises(ProviderNotConfigured):
                build_adapter(provider, env)
    with pytest.raises(ProviderNotConfigured):
        build_adapter("simulated", "staging")
