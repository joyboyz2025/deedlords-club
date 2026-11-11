# slim-glb.py <in.glb> <out.glb> [texture size]: makes a generated model light enough for the web.
# Keeps the geometry and the colour image only (the scene lights models without normal or metal maps), shrinks the
# image to `texture size` pixels (default 1024) and writes it as a JPEG. Needs Pillow.
import io, json, struct, sys
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024

data = open(src, "rb").read()
assert data[:4] == b"glTF", "not a GLB file"
json_len = struct.unpack_from("<I", data, 12)[0]
gltf = json.loads(data[20 : 20 + json_len])
bin_start = 20 + json_len + 8
binary = data[bin_start : bin_start + struct.unpack_from("<I", data, 20 + json_len)[0]]

views = gltf["bufferViews"]
chunk = lambda index: binary[views[index].get("byteOffset", 0) : views[index].get("byteOffset", 0) + views[index]["byteLength"]]

# The colour image of the first material that has one; every material is pointed at it.
colour = None
for material in gltf.get("materials", []):
    texture = material.get("pbrMetallicRoughness", {}).get("baseColorTexture")
    if texture is not None and colour is None:
        colour = gltf["textures"][texture["index"]]["source"]
picture = None
if colour is not None:
    image = Image.open(io.BytesIO(chunk(gltf["images"][colour]["bufferView"]))).convert("RGB")
    if max(image.size) > size:
        image = image.resize((size, size), Image.LANCZOS)
    packed = io.BytesIO()
    image.save(packed, "JPEG", quality=84, optimize=True)
    picture = packed.getvalue()

# Rebuild the buffer from the views the accessors use, then the one image.
used = sorted({accessor["bufferView"] for accessor in gltf["accessors"] if "bufferView" in accessor})
remap, parts, offset = {}, [], 0
for index in used:
    blob = chunk(index)
    blob += b"\0" * (-len(blob) % 4)
    remap[index] = len(parts)
    parts.append((views[index], offset, len(chunk(index)), blob))
    offset += len(blob)
new_views = [{**{k: v for k, v in view.items() if k not in ("byteOffset", "byteLength", "buffer")}, "buffer": 0, "byteOffset": at, "byteLength": length} for view, at, length, _ in parts]
for accessor in gltf["accessors"]:
    if "bufferView" in accessor:
        accessor["bufferView"] = remap[accessor["bufferView"]]
body = b"".join(blob for *_, blob in parts)
if picture:
    new_views.append({"buffer": 0, "byteOffset": len(body), "byteLength": len(picture)})
    body += picture + b"\0" * (-len(picture) % 4)
    gltf["images"] = [{"bufferView": len(new_views) - 1, "mimeType": "image/jpeg"}]
    gltf["textures"] = [{"source": 0, **({"sampler": 0} if gltf.get("samplers") else {})}]
    for material in gltf.get("materials", []):
        pbr = material.setdefault("pbrMetallicRoughness", {})
        pbr.pop("metallicRoughnessTexture", None)
        pbr["baseColorTexture"] = {"index": 0}
        pbr["metallicFactor"], pbr["roughnessFactor"] = 0, 1
        for extra in ("normalTexture", "occlusionTexture", "emissiveTexture"):
            material.pop(extra, None)
gltf["bufferViews"] = new_views
gltf["buffers"] = [{"byteLength": len(body)}]

text = json.dumps(gltf, separators=(",", ":")).encode()
text += b" " * (-len(text) % 4)
with open(out, "wb") as f:
    f.write(struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(text) + 8 + len(body)))
    f.write(struct.pack("<I4s", len(text), b"JSON") + text)
    f.write(struct.pack("<I4s", len(body), b"BIN\0") + body)
triangles = sum(gltf["accessors"][p["indices"]]["count"] // 3 for m in gltf["meshes"] for p in m["primitives"] if "indices" in p)
print(f"{out}: {len(data) / 1e6:.2f} MB -> {(28 + len(text) + len(body)) / 1e6:.2f} MB, {triangles} triangles, colour image {size}px")
