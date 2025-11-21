// controller-panel-tap-system.ts
//
// Uses XR controller rays to "hover" / "click" on the CameraPanel.
// Right-hand controller only controls the reticle.
// Hover updates panelHoverUv + pendingRayUv every frame for manifold scanning.

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
  private prevPressed = new Map<XRInputSource, boolean>();

  update(dt: number, time: number) {
    const globals = this.globals as any;
    const tapState: TapHitState | undefined = globals.tapHitState;
    if (!tapState) return;

    const xrMgr: any = this.xrManager;
    const session: XRSession | null = xrMgr.getSession?.() ?? null;
    const frame = this.xrFrame as XRFrame | null;
    const refSpace: XRReferenceSpace | null =
      xrMgr.getReferenceSpace?.() ?? null;

    if (!session || !frame || !refSpace) return;

    const scene = this.scene as THREE.Scene;
    const panel = scene.getObjectByName("CameraPanel") as THREE.Mesh | null;
    if (!panel) return;

    let hoverUv: { u: number; v: number } | null = null;
    let pendingPanelHitPointRef: PanelHitPointRef = null;

    for (const inputSource of session.inputSources) {
      if (inputSource.targetRayMode !== "tracked-pointer") continue;

      // Only let the RIGHT controller drive the cursor
      if (inputSource.handedness && inputSource.handedness !== "right") {
        continue;
      }

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
      const hovering = hits.length > 0;

      const gp = inputSource.gamepad;
      const pressed =
        !!gp && !!gp.buttons && !!gp.buttons[0] && gp.buttons[0].pressed;
      const prev = this.prevPressed.get(inputSource) ?? false;

      if (hovering) {
        const hit = hits[0];
        if (hit.uv) {
          const u = hit.uv.x;
          const v = 1 - hit.uv.y; // (0,0) = top-left

          hoverUv = { u, v };

          // Continuous manifold scanning: always feed pendingRayUv
          tapState.pendingRayUv = { u, v };

          // Optional click semantics (for a solid dot on the panel)
          if (pressed && !prev) {
            tapState.lastTapUv = { u, v };

            const p = hit.point;
            pendingPanelHitPointRef = { x: p.x, y: p.y, z: p.z };

            console.log(
              "[ControllerPanelTap] click on panel uv:",
              u.toFixed(3),
              v.toFixed(3),
            );
          }
        }
      }

      this.prevPressed.set(inputSource, pressed);
    }

    globals.panelHoverUv = hoverUv;
    if (pendingPanelHitPointRef) {
      globals.pendingPanelHitPointRef = pendingPanelHitPointRef;
    }
  }
}
