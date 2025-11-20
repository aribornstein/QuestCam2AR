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

type CameraExtrinsics = {
  lensTranslation: { x: number; y: number; z: number };
  lensRotation: { x: number; y: number; z: number; w: number };
} | null;

/**
 * Query Quest camera extrinsics once, using getUserMedia.
 * We immediately stop the stream; we only need the settings.
 */
async function queryQuestCameraExtrinsics(): Promise<CameraExtrinsics> {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.warn("[Intrinsics] mediaDevices.getUserMedia not available");
    return null;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { exact: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 1080 },
      },
    });

    const track = stream.getVideoTracks()[0];
    const settings: any = track.getSettings();
    console.log("[Intrinsics] raw track settings:", settings);

    // Clean up stream immediately – we only need settings
    track.stop();
    stream.getTracks().forEach((t) => t.stop());

    if (!settings.lensTranslation || !settings.lensRotation) {
      console.warn(
        "[Intrinsics] Missing lensTranslation / lensRotation on settings",
      );
      return null;
    }

    const lt = settings.lensTranslation as DOMPointReadOnly;
    const lr = settings.lensRotation as DOMPointReadOnly;

    const extrinsics: CameraExtrinsics = {
      lensTranslation: { x: lt.x, y: lt.y, z: lt.z },
      lensRotation: { x: lr.x, y: lr.y, z: lr.z, w: lr.w },
    };

    console.log("[Intrinsics] parsed extrinsics:", extrinsics);
    return extrinsics;
  } catch (e) {
    console.warn("[Intrinsics] Failed to query camera extrinsics", e);
    return null;
  }
}

async function main() {
  try {
    // Just to warm up IWS camera permissions
    try {
      await CameraUtils.getDevices();
      console.log("[Camera] Devices ready");
    } catch (err) {
      console.warn("[Camera] Devices unavailable", err);
    }

    // 1) Ask Quest for lens pose once
    const cameraExtrinsics = await queryQuestCameraExtrinsics();

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
          spatialUI: {}, // pointer / controller rays
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
      cameraImageMapping: null,
      cameraExtrinsics, // <--- NEW: lens pose from getUserMedia
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

      // Panel UV -> camera UV -> ray -> hit-test -> reticle
      .registerSystem(TapHitDebugSystem);

    console.log(
      "World created. CameraPanelSystem + ControllerPanelTapSystem + TapHitDebugSystem ready.",
    );
  } catch (e) {
    console.error("Fatal init error", e);
  }
}

main();
