import json
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent / "fixtures"


def load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def ring_doc() -> dict:
    return load(REPO / "09_JEWELRY_ENGINE" / "fixtures" / "ring.json")


@pytest.fixture
def pendant_doc() -> dict:
    return load(FIXTURES / "pendant_disc.json")
