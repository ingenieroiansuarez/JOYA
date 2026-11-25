"""Minimal CAD proof; requires approved CadQuery and trimesh. Not production geometry."""
from pathlib import Path
import json,math,hashlib
import cadquery as cq
import trimesh

def run(out):
    out.mkdir(exist_ok=True,parents=True)
    result=[]
    for name,diam,width,thickness in [('ring_classic',18,4,1.8),('pendant_disc',20,2,0)]:
        outer=diam/2+thickness
        w=cq.Workplane('XY').circle(outer)
        if thickness:w=w.circle(diam/2)
        solid=w.extrude(width)
        expected=math.pi*(outer**2-(diam/2)**2 if thickness else outer**2)*width
        assert solid.val().isValid() and abs(solid.val().Volume()-expected)<1e-7
        step=out/(name+'.step');stl=out/(name+'.stl');glb=out/(name+'.glb')
        cq.exporters.export(solid,str(step));cq.exporters.export(solid,str(stl),tolerance=0.01,angularTolerance=0.1)
        restored=cq.importers.importStep(str(step));assert restored.val().isValid();assert abs(restored.val().Volume()-expected)<1e-5
        mesh=trimesh.load_mesh(stl);assert mesh.is_watertight and mesh.is_winding_consistent
        # glTF meters and Y-up (rotate -90 degrees around X)
        preview=mesh.copy();preview.apply_transform(trimesh.transformations.rotation_matrix(-math.pi/2,[1,0,0]));preview.apply_scale(.001);preview.export(glb)
        result.append({'name':name,'volumeExpectedMm3':expected,'volumeCadMm3':solid.val().Volume(),'volumeStepMm3':restored.val().Volume(),'volumeStlMm3':mesh.volume,'stlWatertight':bool(mesh.is_watertight),'units':{'step':'mm','stl':'mm by convention','glb':'m'},'hashes':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in [step,stl,glb]},'status':'POC_ONLY_NOT_APPROVED_FOR_MANUFACTURING'})
    (out/'report.json').write_text(json.dumps({'cadquery':cq.__version__,'trimesh':trimesh.__version__,'results':result},indent=2));print(json.dumps(result,indent=2))
if __name__=='__main__':run(Path(__file__).parent/'output')
