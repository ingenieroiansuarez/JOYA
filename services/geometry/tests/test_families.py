from conftest import REPO, load

from aurea_geometry.families import FAMILIES


def test_family_specs_match_handoff_library():
    library = {f["id"]: f for f in load(REPO / "11_3D_ASSET_LIBRARY" / "families.json")}
    for fid, spec in FAMILIES.items():
        src = library[fid]
        assert spec.version == src["version"]
        assert set(spec.params) == set(src["parameters"])
        for name, p in spec.params.items():
            s = src["parameters"][name]
            assert (p.minimum, p.maximum, p.default, p.unit) == (s["min"], s["max"], s["default"], s["unit"])
