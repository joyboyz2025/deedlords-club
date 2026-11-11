# add-unit.py <unit id> <exported.glb>: slims a generated unit model into public/arena/units/ and lists it in
# public/arena/models.json, where the Arena scene finds it.
import json, subprocess, sys, os

unit, src = sys.argv[1], sys.argv[2]
here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, "../..")
ids = [u["id"] for u in json.load(open(os.path.join(root, "shared/arena.json")))["units"]]
assert unit in ids, f"{unit} is not a unit id ({', '.join(ids)})"
subprocess.run([sys.executable, "-I", os.path.join(here, "slim-glb.py"), src, os.path.join(root, f"public/arena/units/{unit}.glb"), "1024"], check=True)
path = os.path.join(root, "public/arena/models.json")
listed = json.load(open(path))
listed["units"][unit] = f"{unit}.glb"
listed["units"] = {key: listed["units"][key] for key in ids if key in listed["units"]}
open(path, "w").write(json.dumps(listed, indent=2) + "\n")
