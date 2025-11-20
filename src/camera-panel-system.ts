// camera-panel-system.ts
//
// Head-locked camera panel that shows the camera feed with NO letterboxing.
// Exports a simple cameraImageMapping used by TapHitDebugSystem.
//
// Panel is a small “tablet” in front of your head, with the same aspect ratio
// as the camera frame (1280x1080).

import { createSystem, CameraUtils } from "@iwsdk/core";
import * as THREE from "three";

type TapHitState = {
  lastTapUv: { u: number; v: number } | null;
  pendingRayUv: { u: number; v: number } | null;
};

type HoverUv = { u: number; v: number } | null;

// Match the camera frame aspect 1280x1080
const PANEL_W = 1280;
const PANEL_H = 1080;

// Physical size in meters (height). Width scales by aspect.
const PANEL_HEIGHT_M = 0.6;
const PANEL_DISTANCE = 1.0;

export class CameraPanelSystem extends createSystem({}, {}) {
  private panelMesh: THREE.Mesh | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private texture: THREE.CanvasTexture | null = null;

  private ensurePanel() {
    if (this.panelMesh) return;

    const camera = this.camera as THREE.PerspectiveCamera;
    if (!camera) return;

    // Canvas with same aspect ratio as the camera frame
    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;

    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) {
      console.warn("[CameraPanelSystem] Failed to get 2D context");
      this.canvas = null;
      return;
    }

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.needsUpdate = true;

    const aspect = PANEL_W / PANEL_H;
    const panelWidthM = PANEL_HEIGHT_M * aspect;
    const panelHeightM = PANEL_HEIGHT_M;

    const geo = new THREE.PlaneGeometry(panelWidthM, panelHeightM);
    const mat = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.95,
    });

    this.panelMesh = new THREE.Mesh(geo, mat);
    this.panelMesh.name = "CameraPanel";

    // Head-locked: attach to XR camera
    camera.add(this.panelMesh);
    this.panelMesh.position.set(0, 0, -PANEL_DISTANCE);

    console.log(
      "[CameraPanelSystem] Created head-locked panel | size (m):",
      panelWidthM.toFixed(3),
      "x",
      panelHeightM.toFixed(3),
      "| distance:",
      PANEL_DISTANCE,
    );
  }

  update(dt: number, time: number) {
    this.ensurePanel();

    if (!this.panelMesh || !this.canvas || !this.ctx || !this.texture) return;

    const globals = this.globals as any;
    const tapState: TapHitState | undefined = globals.tapHitState;
    const hoverUv: HoverUv = globals.panelHoverUv ?? null;

    // Get camera frame from Immersive Web SDK
    const cameraEntity = globals.cameraEntity;
    if (!cameraEntity) return;

    const frameCanvas: HTMLCanvasElement | null =
      CameraUtils.captureFrame?.(cameraEntity) ?? null;

    if (!frameCanvas) return;

    const srcW = frameCanvas.width;
    const srcH = frameCanvas.height;
    if (!srcW || !srcH) return;

    const dstW = this.canvas.width;
    const dstH = this.canvas.height;

    // Simple: draw full frame into full panel canvas, no letterbox/crop
    this.ctx.clearRect(0, 0, dstW, dstH);
    this.ctx.drawImage(frameCanvas, 0, 0, srcW, srcH, 0, 0, dstW, dstH);

    // Export simple mapping for TapHitDebugSystem:
    // panel UV -> panel pixels -> image UV (1:1)
    globals.cameraImageMapping = {
      srcW,
      srcH,
      panelW: dstW,
      panelH: dstH,
    };

    // Hover cursor (for visual feedback)
    if (hoverUv) {
      const x = hoverUv.u * dstW;
      const y = hoverUv.v * dstH;

      this.ctx.beginPath();
      this.ctx.arc(x, y, 12, 0, Math.PI * 2);
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "rgba(0,170,255,0.7)";
      this.ctx.stroke();
    }

    // Tap dot (when user "clicks" the panel)
    if (tapState?.lastTapUv) {
      const x = tapState.lastTapUv.u * dstW;
      const y = tapState.lastTapUv.v * dstH;

      this.ctx.beginPath();
      this.ctx.arc(x, y, 10, 0, Math.PI * 2);
      this.ctx.fillStyle = "#00aaff";
      this.ctx.fill();
    }

    this.texture.needsUpdate = true;
  }
}
