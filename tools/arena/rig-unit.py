# rig-unit.py: gives a unit model a skeleton and its motions (Idle, Walk, Attack, Cast), and writes a GLB the Arena
# scene can play. Runs inside Blender, with no window:
#
#   /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/arena/rig-unit.py -- <unit id> <plain.glb> <out.glb> [check dir]
#
# The input is the model without a skeleton, as slim-glb.py left it (for the units rigged so far:
# `git show aea0424:public/arena/units/<id>.glb`). The joints and the poses of a unit are in `rigs/<id>.py`; they were
# placed by eye on pictures of that model, so each unit has a file of its own.
#
# With no `rigs/<id>.py` yet, or with `views` in place of the output, it only writes four pictures of the model
# (front, right, back, top; 800 px, 1.5 mm a pixel, centred as the rig will see it) to place joints on.
# With a check dir, it also writes a picture of every keyed frame of every clip there.
import os
import runpy
import sys
from math import radians

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

unit, src, out, *rest = sys.argv[sys.argv.index("--") + 1 :]
spec_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rigs", unit + ".py")
scene = bpy.context.scene

REST = {}


def idle(sway):
    """Two seconds of breathing: `sway` is the pose at its middle."""
    return [(0, REST), (24, sway), (48, REST)]


def walk(stride=22, carry=None):
    """A one-second walk on the usual leg and left-arm bones. `carry` is held through it by the weapon arm."""
    carry = carry or {}
    step = lambda fore, back, arm, twist: {**carry, f"thigh.{fore}": (-stride, 0, 0), f"shin.{fore}": (6, 0, 0), f"thigh.{back}": (stride - 4, 0, 0), f"shin.{back}": (28, 0, 0), "upper_arm.L": (arm, 0, 0), "chest": (3, 0, twist), "head": (-3, 0, -twist)}
    pass_ = lambda fore, back: {**carry, f"thigh.{fore}": (-4, 0, 0), f"shin.{fore}": (4, 0, 0), f"thigh.{back}": (-6, 0, 0), f"shin.{back}": (40, 0, 0), "chest": (3, 0, 0), "head": (-3, 0, 0)}
    return [(0, step("L", "R", 16, 4)), (6, pass_("L", "R")), (12, step("R", "L", -16, -4)), (18, pass_("R", "L")), (24, None)]


def pictures(folder, shots, scale, size, name):
    """Renders the body from each of `shots` (camera offset from `target`, target) without lights to set up."""
    os.makedirs(folder, exist_ok=True)
    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.type, camera.data.ortho_scale = "ORTHO", scale
    scene.collection.objects.link(camera)
    scene.camera = camera
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.display.shading.light, scene.display.shading.color_type = "STUDIO", "TEXTURE"
    for label, (offset, target) in shots.items():
        camera.location = Vector(target) + Vector(offset)
        camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = os.path.join(folder, name(label))
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera)


for thing in list(bpy.data.objects):
    bpy.data.objects.remove(thing)
bpy.ops.import_scene.gltf(filepath=src, merge_vertices=True)
body = next(o for o in bpy.data.objects if o.type == "MESH")
body.name = unit + "_body"
# The model's node may sit off the origin: baked into the mesh, which is then centred on the origin, feet on the ground.
body.data.transform(body.matrix_world)
body.matrix_world = Matrix.Identity(4)
low = [min(v.co[axis] for v in body.data.vertices) for axis in range(3)]
high = [max(v.co[axis] for v in body.data.vertices) for axis in range(3)]
body.data.transform(Matrix.Translation((-(low[0] + high[0]) / 2, -(low[1] + high[1]) / 2, -low[2])))
# The file splits the surface along its texture seams; welded, the weights can spread over it.
mesh = bmesh.new()
mesh.from_mesh(body.data)
bmesh.ops.remove_doubles(mesh, verts=mesh.verts, dist=1e-5)
mesh.to_mesh(body.data)
mesh.free()

if out == "views" or not os.path.exists(spec_path):
    folder = rest[0] if rest else os.path.dirname(os.path.abspath(out))
    pictures(folder, {"front": ((0, -5, 0), (0, 0, 0.5)), "right": ((5, 0, 0), (0, 0, 0.5)), "back": ((0, 5, 0), (0, 0, 0.5)), "top": ((0, 0, 5), (0, 0, 0))}, 1.2, 800, lambda label: f"{unit}_{label}.png")
    print(f"{unit}: size {[round(high[a] - low[a], 3) for a in range(3)]}, pictures in {folder}")
    sys.exit(0)

# BONES: (name, head, tail, parent) in metres, z up; the figure faces -y, so its right hand is at -x.
# CLIPS: name -> [(frame, pose)] at 24 frames a second. A pose turns bones by (x, y, z) degrees about the world's axes,
# on top of what their parents do: +x leans forward, +z brings the right shoulder forward. `None` repeats the clip's
# first pose, so that it loops.
spec = runpy.run_path(spec_path, {"REST": REST, "idle": idle, "walk": walk})
BONES, CLIPS = spec["BONES"], spec["CLIPS"]

skeleton = bpy.data.objects.new(unit + "_skeleton", bpy.data.armatures.new(unit + "_skeleton"))
scene.collection.objects.link(skeleton)
bpy.context.view_layer.objects.active = skeleton
bpy.ops.object.mode_set(mode="EDIT")
for name, head, tail, parent in BONES:
    bone = skeleton.data.edit_bones.new(name)
    bone.head, bone.tail = head, tail
    if parent:
        bone.parent = skeleton.data.edit_bones[parent]
bpy.ops.object.mode_set(mode="OBJECT")
body.select_set(True)
skeleton.select_set(True)
bpy.ops.object.parent_set(type="ARMATURE_AUTO")
assert all(vertex.groups for vertex in body.data.vertices), "some of the mesh follows no bone"

ORDER = [name for name, *_ in BONES]  # parents before their children


def posed(turns):
    """Each bone's rotation for a pose."""
    for bone in skeleton.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()
    for name in ORDER:
        if name not in turns:
            continue
        bone = skeleton.pose.bones[name]
        pivot = Matrix.Translation(bone.matrix.translation)
        turn = Euler([radians(angle) for angle in turns[name]], "XYZ").to_matrix().to_4x4()
        bone.matrix = pivot @ turn @ pivot.inverted() @ bone.matrix
        bpy.context.view_layer.update()
    return {bone.name: bone.rotation_quaternion.copy() for bone in skeleton.pose.bones}


# Every pose is worked out before the skeleton has an action, so that no action plays over the pose being built.
poses = {clip: [(frame, None if turns is None else posed(turns)) for frame, turns in keys] for clip, keys in CLIPS.items()}
animation = skeleton.animation_data_create()
for clip, keys in poses.items():
    animation.action = bpy.data.actions.new(clip)
    last = {}
    for frame, pose in keys:
        for bone in skeleton.pose.bones:
            rotation = (pose or keys[0][1])[bone.name].copy()
            # The same turn has two quaternions; the one nearer the last key keeps the bone from spinning the long way.
            if bone.name in last and rotation.dot(last[bone.name]) < 0:
                rotation.negate()
            last[bone.name] = rotation
            bone.rotation_quaternion = rotation
            bone.keyframe_insert("rotation_quaternion", frame=frame)

if rest:
    for clip, keys in CLIPS.items():
        animation.action = bpy.data.actions[clip]
        for frame, _ in keys[:-1]:
            scene.frame_set(frame)
            pictures(rest[0], {"": ((-3.6, -3.8, 1.5), (0, -0.2, 0.55))}, 2.0, 420, lambda _: f"{unit}_{clip}_{frame:02d}.png")

# One track per clip: the exporter writes each as an animation of its own.
animation.action = None
for bone in skeleton.pose.bones:
    bone.matrix_basis = Matrix.Identity(4)
for clip in CLIPS:
    action = bpy.data.actions[clip]
    track = animation.nla_tracks.new()
    track.name = clip
    strip = track.strips.new(clip, 0, action)
    if strip.action_slot is None:
        strip.action_slot = action.slots[0]

scene.render.fps = 24
body.select_set(True)
skeleton.select_set(True)
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=True, export_animations=True, export_animation_mode="ACTIONS", export_skins=True)
print(f"{out}: {len(BONES)} bones, clips {', '.join(CLIPS)}")
