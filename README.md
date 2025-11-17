# QuestCam2AR

QuestCam2AR is a WebXR + Meta Spatial SDK prototype that lets you:

- Run an **immersive AR** experience in the browser (Quest + Meta Browser)
- Use the **device camera feed** as a texture on in‑world panels
- Interact with panels via **controller ray / tap**, with hit‑testing and debug overlays
- Integrate with **Meta Spatial** projects using the files under `metaspatial/`

---

## Project Structure

- [index.html](index.html) — Main HTML entry, host for the WebXR canvas.
- [src/index.ts](src/index.ts) — App entry point. Creates the [`@iwsdk/core.World`](src/index.ts), configures XR features (anchors, hit/plane/mesh detection, depth, layers), and sets up shared state for panel interactions.
- [src/panel.ts](src/panel.ts) — Panel registration / system glue (panel entities, registration IDs, etc.).
- [src/camera-panel-system.ts](src/camera-panel-system.ts) — Applies XR camera frames (via [`CameraSource`](src/index.ts)) to a panel so the panel shows a live camera feed.
- [src/controller-panel-tap-system.ts](src/controller-panel-tap-system.ts) — Handles controller ray / tap interaction with panels. Uses the shared `tapHitState` from [`src/index.ts`](src/index.ts) to pass UV hit data.
- [src/tap-hit-debug-system.ts](src/tap-hit-debug-system.ts) — Visual debug of tap hit UVs and rays.
- [src/robot.ts](src/robot.ts) — Robot behavior / animation system.
- [src/yolo.ts](src/yolo.ts), [src/yolo-system.ts](src/yolo-system.ts), [src/yolo-worker.ts](src/yolo-worker.ts) — YOLO object‑detection integration (web worker, inference, and ECS wiring).
- [public/](public/) — Static assets served by Vite:
  - [public/models/](public/models/) — 3D models.
  - [public/textures/](public/textures/) — Textures (includes `webxr.png` used as the logo texture in [`src/index.ts`](src/index.ts)).
  - [public/audio/](public/audio/) — Audio assets.
  - [public/ui/](public/ui/) — UI textures or layout assets.
- [ui/](ui/) — UIKitML layouts for Meta Spatial / runtime UI (e.g. [ui/welcome.uikitml](ui/welcome.uikitml)).
- [metaspatial/](metaspatial/) — Meta Spatial project files:
  - [metaspatial/components.json](metaspatial/components.json) — Mapping of ECS components to Meta Spatial component names (e.g. `$com.meta.spatial.toolkit.Panel$`, `$Visible$`, `$Quad$`, etc.).
  - [metaspatial/config.json](metaspatial/config.json) — Project configuration for Meta Spatial integration.
  - [metaspatial/Composition/](metaspatial/Composition/) — Composition layouts (e.g. `deskLamp`, `robot`, etc.).
  - `.metaspatial` / `.localsettings` — Meta Spatial project metadata.

---

## Features

- **Immersive AR session**

  [`World.create`](src/index.ts) is called with:

  - `sessionMode: ImmersiveAR`
  - XR features: anchors, hit test, plane + mesh detection, layers, optional depth sensing

- **Scene understanding**

  [`SceneUnderstandingSystem`](src/index.ts) is registered so you can work with `$XRPlane$`, `$XRMesh$`, and `$XRAnchor$` entities.

- **Camera panel**

  - A `CameraSource` component is added on a `cameraEntity` with `$1920\times1080$` resolution and `$30$ fps`.
  - [`CameraPanelSystem`](src/camera-panel-system.ts) uses this to render the XR camera feed onto a panel.

- **Panel interaction**

  - Shared state in [`src/index.ts`](src/index.ts):

    ```ts
    const tapHitState = {
      lastTapUv: null as { u: number; v: number } | null,
      pendingRayUv: null as { u: number; v: number } | null,
    };
    ```

  - [`ControllerPanelTapSystem`](src/controller-panel-tap-system.ts) writes UV hit data into this state.
  - [`TapHitDebugSystem`](src/tap-hit-debug-system.ts) reads `pendingRayUv` to visualize hits.

- **Meta Spatial components**

  - Components defined in [metaspatial/components.json](metaspatial/components.json) (e.g. `$com.meta.spatial.toolkit.Panel$`, `$Visible$`, `$Quad$`) correspond to ECS components used by the runtime and are intended to be consumed by Meta Spatial tooling.

---

## Getting Started

### Prerequisites

- Node.js (LTS recommended)
- npm or yarn
- A WebXR‑capable browser (Meta Browser on Quest for AR)
- Enabled experimental / WebXR flags if required

### Install

```sh
npm install
```

### Run in Dev Mode

```sh
npm run dev
```

Then:

1. Open the printed URL in a desktop browser for quick iteration.
2. For AR, open the same URL in the **Meta Browser** on your Quest (ensure your dev machine is reachable on the network).

### Build for Production

```sh
npm run build
npm run preview
```

---

## Meta Spatial Integration

The [metaspatial/](metaspatial/) folder is structured to work with Meta Spatial:

- Place / configure your Meta Spatial project files in [metaspatial/](metaspatial/).
- The component mapping in [metaspatial/components.json](metaspatial/components.json) must stay in sync with your ECS components.
- Generated component XMLs (if you use the generation pipeline described in [metaspatial/README.md](metaspatial/README.md)) should be referenced by your Meta Spatial project and should align with assets under [public/](public/).

---

## Development Notes

- Global references exposed on the `world` instance:

  ```ts
  const worldAny = world as any;
  worldAny.globals = {
    cameraEntity,
    tapHitState,
    panelHoverUv: null,
    pendingPanelHitPointRef: null,
  };
  ```

  These are consumed by systems such as [`CameraPanelSystem`](src/camera-panel-system.ts) and [`ControllerPanelTapSystem`](src/controller-panel-tap-system.ts).

- The root camera is positioned at $(0, 1, 0.5)$ in world space for a comfortable default eye height:

  ```ts
  const { camera } = world;
  camera.position.set(0, 1, 0.5);
  ```

---

## License

Add your license information here (e.g. MIT, proprietary, etc.).

