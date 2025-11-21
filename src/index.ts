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

type CameraIntrinsics = {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  distortion?: number[];
  lensRotation?: { x: number; y: number; z: number; w: number };
  lensTranslation?: { x: number; y: number; z: number };
};

async function fetchCameraIntrinsics(): Promise<CameraIntrinsics | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });

    const track = stream.getVideoTracks()[0];
    const settings: any = track.getSettings();
    console.log("[Intrinsics] raw track settings:", settings);

    const calib: number[] | undefined = settings.lensIntrinsicCalibration;
    const dist: number[] | undefined = settings.lensDistortion;
    const rot: DOMPointReadOnly | undefined = settings.lensRotation;
    const trans: DOMPointReadOnly | undefined = settings.lensTranslation;

    if (!calib || calib.length < 4) {
      console.warn("[Intrinsics] lensIntrinsicCalibration missing or too short");
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }

    const [fx, fy, cx, cy] = calib;
    const width = settings.width;
    const height = settings.height;

    if (!width || !height || !fx || !fy) {
      console.warn(
        "[Intrinsics] Missing one or more fields (w,h,fx,fy,cx,cy). Cannot build intrinsics yet.",
      );
      track.stop();
      stream.getTracks().forEach((t) => t.stop());
      return null;
    }

    const intrinsics: CameraIntrinsics = {
      width,
      height,
      fx,
      fy,
      cx,
      cy,
      distortion: dist,
      lensRotation: rot
        ? { x: rot.x, y: rot.y, z: rot.z, w: rot.w }
        : undefined,
      lensTranslation: trans
        ? { x: trans.x, y: trans.y, z: trans.z }
        : undefined,
    };

    track.stop();
    stream.getTracks().forEach((t) => t.stop());

    console.log("[Intrinsics] parsed:", intrinsics);
    return intrinsics;
  } catch (e) {
    console.warn("[Intrinsics] getUserMedia failed:", e);
    return null;
  }
}

async function main() {
  try {
    try {
      await CameraUtils.getDevices();
      console.log("[Camera] Devices ready");
    } catch (err) {
      console.warn("[Camera] Devices unavailable", err);
    }

    // 1) Fetch intrinsics/extrinsics once up front
    const cameraIntrinsics = await fetchCameraIntrinsics();

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
      cameraIntrinsics, // <--- NEW
      cameraImageMapping: null,
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

      // Panel UV -> camera ray (intrinsics) -> hit-test -> reticle
      .registerSystem(TapHitDebugSystem);

    console.log(
      "World created. CameraPanelSystem + ControllerPanelTapSystem + TapHitDebugSystem ready.",
    );
  } catch (e) {
    console.error("Fatal init error", e);
  }
}

main();
