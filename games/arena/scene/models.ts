// Models made outside the code: the arena map and, for the units that have one, a figure that stands in for the one
// built from primitives. They are listed in `/arena/models.json`; with no list, or a model that fails to load, the
// scene keeps what it builds itself.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/** `map`: a file under `/arena/`, or `null`. `units`: a file under `/arena/units/` per unit id. `portraits`: the unit ids that have `/arena/portraits/<id>.jpg`. */
export type Manifest = { map: string | null; units: Record<string, string>; portraits: string[] };

let listed: Promise<Manifest> | null = null;
export function manifest(): Promise<Manifest> {
  listed ??= fetch("/arena/models.json")
    .then((response) => (response.ok ? (response.json() as Promise<Manifest>) : Promise.reject(new Error("no list"))))
    .catch(() => ({ map: null, units: {}, portraits: [] }));
  return listed;
}

/**
 * Loads a GLB and gives every mesh a plain lit material with the model's colour image: no reflections to light, cheap
 * on a phone. A model with a skeleton keeps its clips in `animations`.
 */
export async function loadModel(url: string): Promise<THREE.Object3D> {
  const { scene, animations } = await new GLTFLoader().loadAsync(url);
  scene.animations = animations;
  scene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    // A mesh on a skeleton is culled by where it stood when it was bound, not by where its bones have taken it.
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
    const old = mesh.material as THREE.MeshStandardMaterial;
    mesh.material = new THREE.MeshLambertMaterial({ map: old.map, color: old.map ? "#ffffff" : old.color });
    for (const extra of [old.normalMap, old.metalnessMap, old.roughnessMap]) extra?.dispose();
    old.dispose();
    mesh.castShadow = mesh.receiveShadow = true;
  });
  return scene;
}

/** Frees everything a loaded model holds. */
export function disposeModel(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const material = mesh.material as THREE.MeshLambertMaterial;
    material.map?.dispose();
    material.dispose();
  });
}

/** A unit's model standing on the origin, `height` tall, centred on its own axis. Its clips go with it. */
export function standing(model: THREE.Object3D, height: number): THREE.Group {
  // A mesh on a skeleton is measured where its bones hold it, so the bones are placed first.
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = height / size.y;
  model.scale.setScalar(scale);
  model.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  const group = new THREE.Group();
  group.add(model);
  group.animations = model.animations;
  return group;
}

/**
 * The map laid under the board: scaled so its longer side is `span` wide, centred, and lowered so that the ground at
 * its middle (the courtyard the units stand on) is at height 0.
 */
export function laidOut(model: THREE.Object3D, span: number): THREE.Group {
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const scale = span / Math.max(size.x, size.z);
  model.scale.setScalar(scale);
  model.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
  const group = new THREE.Group();
  group.add(model);
  group.updateMatrixWorld(true);
  const down = new THREE.Raycaster(new THREE.Vector3(0, 100, 0), new THREE.Vector3(0, -1, 0));
  const floor = down.intersectObject(group, true)[0];
  if (floor) group.position.y = -floor.point.y;
  return group;
}
