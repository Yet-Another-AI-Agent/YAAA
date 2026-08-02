# 3D Graphics Skill (Three.js Documentation)

The 3D Graphics Skill enables agents and sub-agents to programmatically build 3D scenes, WebGL animations, geometries, materials, lighting, and GLTF models using **Three.js** (`three`).

---

## 1. Overview & Setup

### Installation
```bash
npm install three @types/three
```

### Basic Imports
```typescript
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
```

---

## 2. Scene, Camera, and WebGL Renderer Setup

```typescript
// 1. Create Scene
const scene = new THREE.Scene();
scene.background = new THREE.Color("#181825");
scene.fog = new THREE.FogExp2("#181825", 0.015);

// 2. Perspective Camera
const fov = 60;
const aspect = window.innerWidth / window.innerHeight;
const near = 0.1;
const far = 1000;
const camera = new THREE.PerspectiveCamera(fov, aspect, near, far);
camera.position.set(0, 5, 12);

// 3. WebGL Renderer
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

document.body.appendChild(renderer.domElement);
```

---

## 3. Lighting Architecture

```typescript
// Ambient Light
const ambientLight = new THREE.AmbientLight("#585B70", 0.8);
scene.add(ambientLight);

// Directional Light with Shadows
const dirLight = new THREE.DirectionalLight("#F5E0DC", 1.5);
dirLight.position.set(10, 20, 15);
dirLight.castShadow = true;
dirLight.shadow.mapSize.width = 2048;
dirLight.shadow.mapSize.height = 2048;
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 50;
scene.add(dirLight);

// Colored Point Light Glow
const pointLight = new THREE.PointLight("#A78BFA", 3, 20);
pointLight.position.set(0, 3, 0);
scene.add(pointLight);
```

---

## 4. Geometries, Materials, and Meshes

```typescript
// Floor Plane Mesh
const planeGeo = new THREE.PlaneGeometry(50, 50);
const planeMat = new THREE.MeshStandardMaterial({
  color: "#1E1E2E",
  roughness: 0.4,
  metalness: 0.2
});
const floor = new THREE.Mesh(planeGeo, planeMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// Styled Glass Box Mesh
const boxGeo = new THREE.BoxGeometry(2, 2, 2);
const boxMat = new THREE.MeshPhysicalMaterial({
  color: "#A78BFA",
  transmission: 0.9, // Glass transparency
  opacity: 1,
  transparent: true,
  roughness: 0.1,
  ior: 1.5
});
const cube = new THREE.Mesh(boxGeo, boxMat);
cube.position.set(0, 2, 0);
cube.castShadow = true;
scene.add(cube);
```

---

## 5. Animation Loop & OrbitControls

```typescript
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const elapsedTime = clock.getElapsedTime();

  // Rotate Mesh
  cube.rotation.x = elapsedTime * 0.5;
  cube.rotation.y = elapsedTime * 0.8;
  cube.position.y = 2 + Math.sin(elapsedTime * 2) * 0.3; // Floating effect

  controls.update();
  renderer.render(scene, camera);
}

animate();
```

---

## 6. Best Practices for Agents

1. **Pixel Ratio Handling**: Use `Math.min(window.devicePixelRatio, 2)` to avoid performance bottlenecks on 4K displays.
2. **Dispose Memory**: Call `geometry.dispose()` and `material.dispose()` when removing 3D meshes to avoid WebGL memory leaks.
3. **Shadow Maps**: Limit shadow-casting lights to 1–2 key lights per scene.

---

## 7. Advanced Reference Documentation & Links

- **Official Three.js Documentation**: [https://threejs.org/docs/](https://threejs.org/docs/)
- **Three.js Interactive Examples Showcase**: [https://threejs.org/examples/](https://threejs.org/examples/)
- **Three.js GitHub Repository**: [https://github.com/mrdoob/three.js](https://github.com/mrdoob/three.js)
- **Advanced Topics & Guides**:
  - **Custom GLSL Shaders & Materials**: [https://threejs.org/docs/#api/en/materials/ShaderMaterial](https://threejs.org/docs/#api/en/materials/ShaderMaterial) (`ShaderMaterial`, `RawShaderMaterial`, custom vertex and fragment shaders for raymarching, volumetric fog, and visual effects).
  - **InstancedMesh High-Performance Rendering**: [https://threejs.org/docs/#api/en/objects/InstancedMesh](https://threejs.org/docs/#api/en/objects/InstancedMesh) (rendering 10,000+ identical 3D objects with a single WebGL draw call).
  - **Post-Processing Pipeline**: [https://threejs.org/docs/#manual/en/introduction/How-to-use-post-processing](https://threejs.org/docs/#manual/en/introduction/How-to-use-post-processing) (`EffectComposer`, Bloom pass, Screen-Space Ambient Occlusion (SSAO pass), Motion Blur, and Chromatic Aberration).
  - **GLTF / GLB 3D Model Loading & Animations**: [https://threejs.org/docs/#examples/en/loaders/GLTFLoader](https://threejs.org/docs/#examples/en/loaders/GLTFLoader) (loading compressed 3D assets, Draco mesh decompression, and `AnimationMixer` keyframe playback).
  - **Physics Engine Integration**: [https://threejs.org/docs/#manual/en/introduction/Animation-system](https://threejs.org/docs/#manual/en/introduction/Animation-system) (integrating Cannon-es or Rapier 3D rigid bodies, colliders, and gravity simulations).
