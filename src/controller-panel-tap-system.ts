// controller-panel-tap-system.ts
//
// CONTINUOUS MANIFOLD MODE (RIGHT CONTROLLER ONLY):
// - As long as the RIGHT controller's ray is hovering over the CameraPanel,
//   we treat that as the current (u,v) on the 2D manifold.
// - We continuously update tapState.lastTapUv (for the blue dot)
//   and tapState.pendingRayUv (for TapHitDebugSystem).
//
// The left controller can still exist and point around, but it will NOT
// move the panel cursor or reticle.

import { createSystem } from "@iwsdk/core";
import * as THREE from "three";

type TapHitState = {
  lastTapUv: { u: number; v: number } | null;
  pendingRayUv: { u: number; v: number } | null;
};

type PanelHitPointRef = {
  x: number;
  y: number;
  z: number;
} | null;

export class ControllerPanelTapSystem extends createSystem({}, {}) {
  private raycaster = new THREE.Raycaster();

  update(dt: number, time: number) {
    const globals = this.globals as any;
    const tapState: TapHitState | undefined = globals.tapHitState;
    if (!tapState) return;

    const xrMgr: any = this.xrManager;
    const session: XRSession | null = xrMgr.getSession?.() ?? null;
    const frame = this.xrFrame as XRFrame | null;
    const refSpace: XRReferenceSpace | null =
      xrMgr.getReferenceSpace?.() ?? null;

    if (!session || !frame || !refSpace) {
      return;
    }

    const scene = this.scene as THREE.Scene;
    const panel = scene.getObjectByName("CameraPanel") as THREE.Mesh | null;
    if (!panel) return;

    // Defaults if the right-hand controller doesn't hover the panel this frame
    let hoverUv: { u: number; v: number } | null = null;
    let pendingPanelHitPointRef: PanelHitPointRef = null;

    // Only consider the RIGHT controller for panel interaction
    for (const inputSource of session.inputSources) {
      if (inputSource.targetRayMode !== "tracked-pointer") continue;
      if (inputSource.handedness !== "right") continue; // <-- filter to right hand

      const targetRaySpace = inputSource.targetRaySpace;
      if (!targetRaySpace) continue;

      const pose = frame.getPose(targetRaySpace, refSpace);
      if (!pose) continue;

      const pos = pose.transform.position;
      const ori = pose.transform.orientation;

      const origin = new THREE.Vector3(pos.x, pos.y, pos.z);
      const quat = new THREE.Quaternion(ori.x, ori.y, ori.z, ori.w);
      const direction = new THREE.Vector3(0, 0, -1)
        .applyQuaternion(quat)
        .normalize();

      this.raycaster.set(origin, direction);

      const hits = this.raycaster.intersectObject(panel, false);
      if (!hits.length) {
        continue;
      }

      const hit = hits[0];
      if (!hit.uv) {
        continue;
      }

      const uPanel = hit.uv.x;
      const vPanel = 1 - hit.uv.y; // (0,0) = top-left

      hoverUv = { u: uPanel, v: vPanel };

      // Continuous manifold mode: every hover sample updates UVs.
      tapState.lastTapUv = { u: uPanel, v: vPanel };
      tapState.pendingRayUv = { u: uPanel, v: vPanel };

      const p = hit.point;
      pendingPanelHitPointRef = { x: p.x, y: p.y, z: p.z };

      // Optional debug:
      // console.log(
      //   "[ControllerPanelTap] (right) hover on panel uv:",
      //   uPanel.toFixed(3),
      //   vPanel.toFixed(3),
      // );

      // We only care about the right controller; once we processed it,
      // we can break out of the loop.
      break;
    }

    // Export hover + hit point (or null if right controller isn't on the panel)
    globals.panelHoverUv = hoverUv;
    if (pendingPanelHitPointRef) {
      globals.pendingPanelHitPointRef = pendingPanelHitPointRef;
    } else {
      globals.pendingPanelHitPointRef = null;
    }
  }
}
