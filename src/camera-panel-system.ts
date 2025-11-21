// camera-panel-system.ts

import { createSystem, CameraUtils } from "@iwsdk/core";
import * as THREE from "three";

type TapHitState = {
  lastTapUv: { u: number; v: number } | null;
  pendingRayUv: { u: number; v: number } | null;
};

type HoverUv = { u: number; v: number } | null;

const PANEL_W = 1280; // panel rendering width (px)
const PANEL_H = 1280; // panel rendering height (px, square texture)
const PANEL_SIZE_M = 0.6; // physical size in meters
const PANEL_DISTANCE = 1.0; // distance in front of head

export class CameraPanelSystem extends createSystem({}, {}) {
  private panelMesh: THREE.Mesh | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private texture: THREE.CanvasTexture | null = null;

  private ensurePanel() {
    if (this.panelMesh) return;

    const camera = this.camera as THREE.PerspectiveCamera;
    if (!camera) return;

    this.canvas = document.createElement("canvas");
    this.canvas.width = PANEL_W;
    this.canvas.height = PANEL_H;

    this.ctx = this.canvas.getContext("2d");
    if (!this.ctx) throw new Error("canvas 2D context failed");

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(PANEL_SIZE_M, PANEL_SIZE_M);
    const mat = new THREE.MeshBasicMaterial({ map: this.texture });

    this.panelMesh = new THREE.Mesh(geo, mat);
    this.panelMesh.name = "CameraPanel";

    camera.add(this.panelMesh);
    this.panelMesh.position.set(0, 0, -PANEL_DISTANCE);

    console.log("[CameraPanelSystem] Created head-locked panel");
  }

  update(dt: number, time: number) {
    this.ensurePanel();

    if (!this.panelMesh || !this.canvas || !this.ctx || !this.texture) return;

    const globals = this.globals as any;
    const tapState: TapHitState | undefined = globals.tapHitState;
    const hoverUv: HoverUv = globals.panelHoverUv ?? null;

    // Get camera frame
    const cameraEntity = globals.cameraEntity;
    if (!cameraEntity) return;

    const frameCanvas: HTMLCanvasElement | null =
      CameraUtils.captureFrame?.(cameraEntity) ?? null;
    if (!frameCanvas) return;

    const srcW = frameCanvas.width;
    const srcH = frameCanvas.height;
    if (!srcW || !srcH) return;

    // Maintain aspect ratio: letterbox into square texture
    const dstW = PANEL_W;
    const dstH = PANEL_H;

    const srcAR = srcW / srcH;
    const dstAR = dstW / dstH;

    let renderW = 0;
    let renderH = 0;
    let offsetX = 0;
    let offsetY = 0;

    if (srcAR > dstAR) {
      // Wider than square → full width, reduced height
      renderW = dstW;
      renderH = Math.round(dstW / srcAR);
      offsetY = Math.floor((dstH - renderH) / 2);
    } else {
      // Taller → full height, reduced width
      renderH = dstH;
      renderW = Math.round(dstH * srcAR);
      offsetX = Math.floor((dstW - renderW) / 2);
    }

    this.ctx.clearRect(0, 0, dstW, dstH);
    this.ctx.drawImage(
      frameCanvas,
      0,
      0,
      srcW,
      srcH,
      offsetX,
      offsetY,
      renderW,
      renderH,
    );

    // Export mapping for TapHitDebugSystem
    globals.cameraImageMapping = {
      srcW,
      srcH,
      panelW: dstW,
      panelH: dstH,
      renderW,
      renderH,
      offsetX,
      offsetY,
    };

    // Hover cursor (for debugging)
    if (hoverUv) {
      const x = hoverUv.u * dstW;
      const y = hoverUv.v * dstH;

      this.ctx.beginPath();
      this.ctx.arc(x, y, 12, 0, Math.PI * 2);
      this.ctx.lineWidth = 2;
      this.ctx.strokeStyle = "rgba(0,170,255,0.7)";
      this.ctx.stroke();
    }

    // Tap dot (optional)
    if (tapState?.lastTapUv) {
      const x = tapState.lastTapUv.u * dstW;
      const y = tapState.lastTapUv.v * dstH;

      this.ctx.beginPath();
      this.ctx.arc(x, y, 12, 0, Math.PI * 2);
      this.ctx.fillStyle = "#00aaff";
      this.ctx.fill();
    }

    this.texture.needsUpdate = true;
  }
}
