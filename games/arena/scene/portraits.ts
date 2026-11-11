// A head-and-shoulders picture of each unit, taken from its 3D figure once and kept as an image for the shop cards and
// the bench. A small renderer is made for the sixteen shots and thrown away.

import * as THREE from "three";
import { UNITS } from "../data.ts";
import { figureGeometry } from "./figures.ts";

const SIZE = 192;
let taken: string[] | null = null;

/** One PNG data URL per unit, in the order of `UNITS`, on a transparent background. */
export function unitPortraits(): string[] {
  if (taken) return taken;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  const scene = new THREE.Scene();
  const key = new THREE.DirectionalLight("#fff1dc", 2.6);
  key.position.set(-2, 3, 4);
  scene.add(new THREE.HemisphereLight("#dfe6ff", "#5a4a44", 1.7), key);
  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
  camera.position.set(0.7, 1.55, 3.3);
  camera.lookAt(0.05, 1.2, 0);
  const lit = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });

  taken = UNITS.map((_, unit) => {
    const shape = figureGeometry(unit);
    const figure = new THREE.Group();
    const arm = new THREE.Mesh(shape.arm, lit);
    arm.position.copy(shape.shoulder);
    figure.add(new THREE.Mesh(shape.body, lit), arm);
    if (shape.bodyGlow) figure.add(new THREE.Mesh(shape.bodyGlow, glow));
    if (shape.armGlow) arm.add(new THREE.Mesh(shape.armGlow, glow));
    figure.rotation.y = 0.35;
    scene.add(figure);
    renderer.render(scene, camera);
    const picture = renderer.domElement.toDataURL("image/png");
    scene.remove(figure);
    for (const geometry of [shape.body, shape.arm, shape.bodyGlow, shape.armGlow]) geometry?.dispose();
    return picture;
  });
  lit.dispose();
  glow.dispose();
  renderer.dispose();
  return taken;
}
