"""aurea-mesh: run the simulated provider loop end to end and write evidence.

    aurea-mesh OUT_DIR --target-mm 24 --confirmed-by joyero
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .adapter import MeshAdapterError, MeshRequest
from .normalize import ScaleSpec, normalize, write_outputs
from .registry import build_adapter


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="aurea-mesh")
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--target-mm", type=float, required=True, help="confirmed size of the scale axis in mm")
    ap.add_argument("--axis", default="max", choices=["x", "y", "z", "max"])
    ap.add_argument("--confirmed-by", required=True, help="role that confirmed the size, e.g. joyero")
    ap.add_argument("--environment", default="demo", choices=["demo", "test", "production"])
    args = ap.parse_args(argv)

    try:
        adapter = build_adapter("simulated", args.environment)
        req = MeshRequest(
            idempotency_key="cli-demo-0001",
            project_id="prj_demo_0001",
            revision_id="rev_demo_0001",
            prompt="anillo escultórico tipo toroide (demo)",
        )
        job = adapter.generate(req)
        while not job.state.terminal:
            job = adapter.poll(job.job_id)
        if job.state.value != "SUCCEEDED":
            print(f"job ended {job.state.value} ({job.error_code})", file=sys.stderr)
            return 2
        cap = adapter.capabilities()
        report, stl, glb = normalize(
            adapter.result(job.job_id),
            ScaleSpec(target_mm=args.target_mm, axis=args.axis, confirmed_by=args.confirmed_by),
            source={"provider": cap.provider, "modelId": cap.model_id, "version": cap.version,
                    "jobId": job.job_id, "simulated": cap.simulated},
        )
    except MeshAdapterError as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        return 1
    write_outputs(args.out_dir, "mesh", report, stl, glb)
    dfm01 = report["dfm"][0]["state"]
    print(f"{report['status']} simulated={report['simulated']} DFM-01={dfm01} "
          f"bbox_mm={report['result']['bboxMm']} volume_mm3={report['result']['volumeMm3']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
