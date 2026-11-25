# Design for Jewelry Manufacturing
Rules versioned by alloy, process, geometry family and workshop; no universal min thickness. Each rule stores id, severity BLOCK/WARN/REVIEW, measurement method, threshold, unit, provenance, applicability and evidence. DFM result references geometry digest and revision. Missing rule/measurement = REVIEW, never PASS. Human approval remains mandatory even on all PASS. Only authorized nonblocking exceptions with reason; blocked findings must be corrected or reviewed under documented approved policy, not hidden.

| Rule | Check | Evidence |
|---|---|---|
| DFM-01 | Solid validity, watertightness, manifoldness/self-intersections | Kernel diagnostics and mesh edge test |
| DFM-02 | Min wall/feature thickness per process/metal | Sampled distance field and critical sections; approximation flagged |
| DFM-03 | Collisions and intended contact | Pairwise spatial test, semantic contact exceptions |
| DFM-04 | Stone seat fit, prong dimensions and clearance | Measured gemstone lot + anchor fit |
| DFM-05 | Ring inner size, engraving legibility/depth | Dimensions and calibration confirmation |
| DFM-06 | Casting shrinkage, print supports/drainability | Process-specific recipe approved by workshop |
| DFM-07 | CNC/tool access and assembly feasibility | Human review, process route |
| DFM-08 | Mass/volume, material recoverability | BOM by material, scrap assumptions |
| DFM-09 | Export tolerance and unit conversion | STEP/STL reimport, comparison |
| DFM-10 | Surface/stone integrity and physical QC | Actual inspection, not AI inference |

Package release: approved revision + DFM report + human signoff + confirmed dimensions + CAD/mesh + BOM + drawings dimensions/tolerances + process route + license provenance + SHA256 manifest. No machine commands. Fabrication artisan, casting, resin patterns, CNC, laser or outsource; select route with trained operator. Future structural simulation only with validated material models and boundary conditions. Test exact ring analytical volume, degenerate booleans, thin walls, imported non-manifold mesh, intersecting gems, unsupported curves, scale roundtrip. Export test in external CAD/slicer and compare measured physical coupon.
