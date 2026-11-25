import math

import pytest
from conftest import REPO, load

from aurea_geometry.canonical import canonical_digest, canonical_json


@pytest.mark.parametrize("case", load(REPO / "09_JEWELRY_ENGINE" / "fixtures" / "digests.json")["cases"],
                         ids=lambda c: c["name"])
def test_matches_ecmascript_reference(case):
    assert canonical_json(case["value"]) == case["canonical"]
    assert canonical_digest(case["value"]) == case["sha256"]


def test_integral_float_and_int_are_the_same_number():
    assert canonical_digest({"d": 18.0}) == canonical_digest({"d": 18})


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf])
def test_non_finite_numbers_are_rejected(bad):
    with pytest.raises(ValueError):
        canonical_json({"x": bad})
