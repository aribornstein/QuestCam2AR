// controller-panel-tap-system.ts
//
// Uses the RIGHT controller ray to hover & click on the CameraPanel.
// Hover:
//   - updates globals.panelHoverUv
//   - updates tapHitState.pendingRayUv (drives TapHitDebugSystem reticle)
// Click (button 0):
//   - updates tapHitState.lastTapUv (solid dot)

import { createSystem } from "@iwsdk/core";
import * as THREE from "three";

type TapHitState = {
  lastTapUv: { u: number; v: number } | null;
  pendingRayUv: { u: number; v: number } | null;
};

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

    if (!session || !frame || !refSpace) {
      return;
    }

    const scene = this.scene as THREE.Scene;
    const panel = scene.getObjectByName("CameraPanel") as THREE.Mesh | null;
    if (!panel) return;

    let hoverUv: { u: number; v: number } | null = null;

    for (const inputSource of session.inputSources) {
      // Only use right-hand tracked-pointer controllers
      if (inputSource.targetRayMode !== "tracked-pointer") continue;
      if (inputSource.handedness !== "right") continue;

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
          // hit.uv.y is from bottom in Three, so flip so (0,0) is top-left
          const u = hit.uv.x;
          const v = 1 - hit.uv.y;

          hoverUv = { u, v };

          // Continuous hover drives the reticle ray
          tapState.pendingRayUv = { u, v };

          // Click: rising edge of button 0 while hovering
          if (pressed && !prev) {
            tapState.lastTapUv = { u, v };

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
  }
}
