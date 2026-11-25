import math

import pytest
from conftest import FIXTURES, load

from aurea_geometry.document import InvalidDocument, canonical_digest, validate_document


def test_handoff_ring_fixture_is_valid(ring_doc):
    validate_document(ring_doc)


def test_pendant_fixture_is_valid(pendant_doc):
    validate_document(pendant_doc)


CASES = load(FIXTURES / "invalid_cases.json")


@pytest.mark.parametrize("name", sorted(CASES))
def test_invalid_documents_are_rejected(name):
    case = CASES[name]
    with pytest.raises(InvalidDocument) as e:
        validate_document(case["document"])
    assert case["expectedCode"] in {i.code for i in e.value.issues}


def test_non_finite_parameter_rejected(ring_doc):
    ring_doc["components"][0]["parameters"]["bandWidth"] = math.nan
    with pytest.raises(InvalidDocument) as e:
        validate_document(ring_doc)
    assert "NOT_FINITE" in {i.code for i in e.value.issues}


def test_operations_are_refused_not_ignored(ring_doc):
    ring_doc["operations"] = [{"id": "00000000-0000-4000-8000-0000000000aa", "type": "engrave",
                               "target": "ring-base", "parameters": {"text": "A"}}]
    with pytest.raises(InvalidDocument) as e:
        validate_document(ring_doc)
    assert "UNSUPPORTED_OPERATION" in {i.code for i in e.value.issues}


def test_digest_is_key_order_independent(ring_doc):
    reordered = dict(reversed(list(ring_doc.items())))
    assert canonical_digest(reordered) == canonical_digest(ring_doc)
