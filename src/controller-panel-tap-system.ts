// controller-panel-tap-system.ts
//
// CONTINUOUS MANIFOLD MODE:
// - As long as the controller ray is hovering over the CameraPanel,
//   we treat that as the current (u,v) on the 2D manifold.
// - We continuously update tapState.lastTapUv (for the blue dot)
//   and tapState.pendingRayUv (for TapHitDebugSystem).
//
// There is NO button gating anymore: hover == sample ray.

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

    let hoverUv: { u: number; v: number } | null = null;
    let pendingPanelHitPointRef: PanelHitPointRef = null;

    // We’ll just use the first tracked-pointer controller that hits the panel.
    for (const inputSource of session.inputSources) {
      if (inputSource.targetRayMode !== "tracked-pointer") continue;

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

      // For manifold mode, we ALWAYS treat hover as the current sample.
      tapState.lastTapUv = { u: uPanel, v: vPanel };
      tapState.pendingRayUv = { u: uPanel, v: vPanel };

      const p = hit.point;
      pendingPanelHitPointRef = { x: p.x, y: p.y, z: p.z };

      // Optional debug log (comment out if too spammy)
      // console.log(
      //   "[ControllerPanelTap] hover on panel uv:",
      //   uPanel.toFixed(3),
      //   vPanel.toFixed(3),
      // );

      // We only need one controller’s hit per frame, so break here.
      break;
    }

    globals.panelHoverUv = hoverUv;
    if (pendingPanelHitPointRef) {
      globals.pendingPanelHitPointRef = pendingPanelHitPointRef;
    }
  }
}
