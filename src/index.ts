// index.ts

import {
  AssetManifest,
  AssetType,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
  World,
  CameraSource,
  CameraUtils,
  SceneUnderstandingSystem,
  XRPlane,
  XRMesh,
  XRAnchor,
} from "@iwsdk/core";

import { PanelSystem } from "./panel.js";
import { RobotSystem } from "./robot.js";
import { TapHitDebugSystem } from "./tap-hit-debug-system";
import { CameraPanelSystem } from "./camera-panel-system";
import { ControllerPanelTapSystem } from "./controller-panel-tap-system";

// Shared state between panel + systems
const tapHitState = {
  lastTapUv: null as { u: number; v: number } | null,
  pendingRayUv: null as { u: number; v: number } | null, // consumed by TapHitDebugSystem
};

async function main() {
  try {
    try {
      await CameraUtils.getDevices();
      console.log("[Camera] Devices ready");
    } catch (err) {
      console.warn("[Camera] Devices unavailable", err);
    }

    const assets: AssetManifest = {
      webxr: {
        url: "/textures/webxr.png",
        type: AssetType.Texture,
        priority: "critical",
      },
    };

    const world = await World.create(
      document.getElementById("scene-container") as HTMLDivElement,
      {
        assets,
        xr: {
          sessionMode: SessionMode.ImmersiveAR,
          offer: "always",
          features: {
            anchors: { required: true },
            hitTest: { required: true },
            planeDetection: { required: true },
            meshDetection: { required: true },
            layers: { required: true },
            depthSensing: {
              required: false,
              usage: "cpu-optimized",
              format: "float32",
            },
          },
        },
        features: {
          sceneUnderstanding: true,
          camera: true,
          spatialUI: {},      // pointer / controller rays
          locomotion: false,
          grabbing: true,
          physics: true,
        },
        level: "/glxf/Composition.glxf",
      },
    );

    const { camera } = world;
    camera.position.set(0, 1, 0.5);

    // XR camera source for CameraUtils.captureFrame (used by CameraPanelSystem)
    const cameraEntity = world.createEntity();
    cameraEntity.addComponent(CameraSource, {
      deviceId: "",
      facing: "back",
      width: 1920,
      height: 1080,
      frameRate: 30,
    });

    const worldAny = world as any;
    worldAny.globals = {
      cameraEntity,
      tapHitState,
      panelHoverUv: null,
      pendingPanelHitPointRef: null,
    };

    const tex = AssetManager.getTexture("webxr")!;
    tex.colorSpace = SRGBColorSpace;

    const logo = new Mesh(
      new PlaneGeometry(3.39, 0.96),
      new MeshBasicMaterial({
        map: tex,
        transparent: true,
      }),
    );

    world.createTransformEntity(logo);
    logo.position.set(0, 1, 1.8);
    logo.rotateY(Math.PI);

    world
      .registerSystem(SceneUnderstandingSystem)
      .registerComponent(XRPlane)
      .registerComponent(XRMesh)
      .registerComponent(XRAnchor)

      .registerSystem(PanelSystem)
      .registerSystem(RobotSystem)

      // In-world camera panel + controller ray interaction
      .registerSystem(CameraPanelSystem)
      .registerSystem(ControllerPanelTapSystem)

      // (panel hit point) -> world ray -> hit-test -> 3D orb
      .registerSystem(TapHitDebugSystem);

    console.log("World created. CameraPanelSystem + ControllerPanelTapSystem + TapHitDebugSystem ready.");
  } catch (e) {
    console.error("Fatal init error", e);
  }
}

main();
