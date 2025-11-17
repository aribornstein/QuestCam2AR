// tap-hit-debug-system.ts
//
// Panel UV (from ControllerPanelTapSystem hover) ->
//   panel pixels -> camera image UV (A2 letterbox) ->
//   NDC -> world ray -> viewer-space hit-test.
//
// Uses a flat reticle (ring) that:
//   - snaps to the hit-test pose (position + orientation),
//   - is slightly offset along the surface normal to avoid z-fighting,
//   - falls back to a point along the ray if there is no hit.
//
// Designed to work with continuous "manifold scanning" as you hover over the panel.

import { createSystem } from "@iwsdk/core";
import * as THREE from "three";

const FALLBACK_DISTANCE = 2.0;
const HIT_TIMEOUT = 0.4;
const RETICLE_RADIUS_OUTER = 0.07;
const RETICLE_RADIUS_INNER = 0.05;
const RETICLE_Z_OFFSET = 0.002; // meters above surface to avoid z-fighting

type TapHitState = {
  lastTapUv: { u: number; v: number } | null;
  pendingRayUv: { u: number; v: number } | null;
};

type CameraImageMapping = {
  srcW: number;
  srcH: number;
  panelW: number;
  panelH: number;
  renderW: number;
  renderH: number;
  offsetX: number;
  offsetY: number;
} | null;

type Spaces = {
  session: XRSession;
  refSpace: XRReferenceSpace;
  viewerSpace: XRReferenceSpace;
};

export class TapHitDebugSystem extends createSystem({}, {}) {
  private reticle: THREE.Mesh | null = null;
  private spacesPromise: Promise<Spaces | null> | null = null;

  private activeHitSource: XRHitTestSource | null = null;
  private pendingRayRef: { origin: THREE.Vector3; dir: THREE.Vector3 } | null =
    null;
  private timeSinceTap = 0;

  // Rotate RingGeometry's +Z normal to +Y (WebXR surface normal)
  private readonly reticlePreRot = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 2, 0, 0, "XYZ"),
  );

  // ---------------- XR spaces ----------------

  private async ensureSpaces(): Promise<Spaces | null> {
    const xrMgr: any = this.xrManager;
    const session: XRSession | null = xrMgr.getSession?.() ?? null;
    if (!session) return null;

    if (this.spacesPromise) return this.spacesPromise;

    this.spacesPromise = (async () => {
      let refSpace: XRReferenceSpace | null =
        xrMgr.getReferenceSpace?.() ?? null;

      if (!refSpace) {
        refSpace = await session.requestReferenceSpace("local-floor");
      }

      const viewerSpace = await session.requestReferenceSpace("viewer");

      return { session, refSpace, viewerSpace };
    })();

    return this.spacesPromise;
  }

  // ---------------- reticle helpers ----------------

  private ensureReticle(scene: THREE.Scene) {
    if (this.reticle) return;

    const geo = new THREE.RingGeometry(
      RETICLE_RADIUS_INNER,
      RETICLE_RADIUS_OUTER,
      40,
    );

    const mat = new THREE.MeshBasicMaterial({
      color: 0x00aaff,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });

    this.reticle = new THREE.Mesh(geo, mat);
    this.reticle.name = "TapHitReticle";
    this.reticle.visible = false;

    // We'll drive the matrix ourselves
    this.reticle.matrixAutoUpdate = false;

    scene.add(this.reticle);
  }

  private placeReticleAtPoseMatrix(poseTransform: XRRigidTransform) {
    if (!this.reticle) return;

    const poseMat = new THREE.Matrix4().fromArray(poseTransform.matrix);

    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    poseMat.decompose(pos, quat, scale);

    // Rotate reticle so its local +Z (geometry normal) becomes +Y (surface normal)
    quat.multiply(this.reticlePreRot);

    // Compute final surface normal from adjusted quaternion
    const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(quat).normalize();
    pos.addScaledVector(normal, RETICLE_Z_OFFSET);

    this.reticle.position.copy(pos);
    this.reticle.quaternion.copy(quat);
    this.reticle.scale.copy(scale);
    this.reticle.updateMatrix();
    this.reticle.visible = true;
  }

  private placeReticleFallback(origin: THREE.Vector3, dir: THREE.Vector3) {
    if (!this.reticle) return;

    const pos = origin.clone().add(dir.clone().multiplyScalar(FALLBACK_DISTANCE));

    // Orient reticle so its normal roughly faces the ray direction
    const normal = dir.clone().normalize();
    const up = Math.abs(normal.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(up, normal).normalize();
    const bitangent = new THREE.Vector3().crossVectors(normal, tangent).normalize();

    const m = new THREE.Matrix4().makeBasis(tangent, normal, bitangent);
    m.setPosition(pos);

    this.reticle.matrix.copy(m);
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = true;
  }

  // Transform ray from refSpace to viewerSpace
  private rayRefSpaceToViewerSpace(
    originRef: THREE.Vector3,
    dirRef: THREE.Vector3,
    viewerPose: XRViewerPose,
  ) {
    const m = new THREE.Matrix4().fromArray(viewerPose.transform.matrix); // viewer -> ref
    const inv = new THREE.Matrix4().copy(m).invert(); // ref -> viewer

    const oRef4 = new THREE.Vector4(originRef.x, originRef.y, originRef.z, 1.0);
    const oView4 = oRef4.applyMatrix4(inv);
    const originView = new THREE.Vector3(oView4.x, oView4.y, oView4.z);

    const pRef = originRef.clone().add(dirRef);
    const pRef4 = new THREE.Vector4(pRef.x, pRef.y, pRef.z, 1.0);
    const pView4 = pRef4.applyMatrix4(inv);
    const pView = new THREE.Vector3(pView4.x, pView4.y, pView4.z);

    const dirView = pView.sub(originView).normalize();
    return { originView, dirView };
  }

  // ---------------- main update ----------------

  async update(dt: number, time: number) {
    const scene = this.scene as THREE.Scene;
    const camera = this.camera as THREE.PerspectiveCamera;
    const globals = this.globals as any;
    const tapState: TapHitState | undefined = globals.tapHitState;

    this.ensureReticle(scene);

    const frame = this.xrFrame as XRFrame | null;
    const spaces = await this.ensureSpaces();
    if (!frame || !spaces) return;

    const { refSpace, viewerSpace, session } = spaces;

    // 1) If we already have an active hit-test source, poll it
    if (this.activeHitSource) {
      this.timeSinceTap += dt;

      const results = frame.getHitTestResults(this.activeHitSource);

      if (results.length) {
        const pose = results[0].getPose(refSpace);
        if (pose) {
          this.placeReticleAtPoseMatrix(pose.transform);
        }

        this.activeHitSource.cancel();
        this.activeHitSource = null;
        this.pendingRayRef = null;
        this.timeSinceTap = 0;
        return;
      }

      if (this.timeSinceTap > HIT_TIMEOUT && this.pendingRayRef) {
        const { origin, dir } = this.pendingRayRef;
        console.log("[YOLO HIT DEBUG] NO-HIT (timeout) -> fallback");
        this.placeReticleFallback(origin, dir);

        this.activeHitSource.cancel();
        this.activeHitSource = null;
        this.pendingRayRef = null;
        this.timeSinceTap = 0;
      }

      return;
    }

    // 2) No active source: do we have a new hover UV from the panel?
    if (!tapState || !tapState.pendingRayUv) return;

    const mapping: CameraImageMapping = globals.cameraImageMapping ?? null;
    if (!mapping) {
      console.warn("[YOLO HIT DEBUG] No cameraImageMapping; using fallback only");
      tapState.pendingRayUv = null;
      return;
    }

    const { u, v } = tapState.pendingRayUv;
    tapState.pendingRayUv = null; // consume this sample

    const {
      srcW,
      srcH,
      panelW,
      panelH,
      renderW,
      renderH,
      offsetX,
      offsetY,
    } = mapping;

    // Panel UV -> panel pixels
    const px = u * panelW;
    const py = v * panelH;

    // Map into the letterboxed camera region
    const camU = (px - offsetX) / renderW;
    const camV = (py - offsetY) / renderH;

    // Raw image UV
    let uImg = camU;
    let vImg = camV;

    // Optional calibration layer (currently identity)
    const CALIB_OFFSET_X = 0.0;
    const CALIB_OFFSET_Y = 0.0;
    const CALIB_SCALE_X = 1.0;
    const CALIB_SCALE_Y = 1.0;

    uImg = (uImg - 0.5) * CALIB_SCALE_X + 0.5 + CALIB_OFFSET_X;
    vImg = (vImg - 0.5) * CALIB_SCALE_Y + 0.5 + CALIB_OFFSET_Y;

    uImg = THREE.MathUtils.clamp(uImg, 0, 1);
    vImg = THREE.MathUtils.clamp(vImg, 0, 1);

    // Image UV -> NDC
    const xNdc = uImg * 2 - 1;
    const yNdc = 1 - vImg * 2;

    // Build world ray via Three's unproject
    const ndcPoint = new THREE.Vector3(xNdc, yNdc, -1);
    const worldPoint = ndcPoint.clone().unproject(camera);

    const originRef = new THREE.Vector3();
    camera.getWorldPosition(originRef);

    const dirRef = worldPoint.sub(originRef).normalize();

    this.pendingRayRef = { origin: originRef.clone(), dir: dirRef.clone() };
    this.timeSinceTap = 0;

    const fallbackPos = originRef
      .clone()
      .add(dirRef.clone().multiplyScalar(FALLBACK_DISTANCE));

    console.log(
      "[YOLO HIT DEBUG] hover panel uv:",
      u.toFixed(3),
      v.toFixed(3),
      "| img uv:",
      uImg.toFixed(3),
      vImg.toFixed(3),
      "| ndc:",
      xNdc.toFixed(3),
      yNdc.toFixed(3),
      "| origin:",
      originRef.x.toFixed(3),
      originRef.y.toFixed(3),
      originRef.z.toFixed(3),
      "| dir:",
      dirRef.x.toFixed(3),
      dirRef.y.toFixed(3),
      dirRef.z.toFixed(3),
    );

    const viewerPose = frame.getViewerPose(refSpace);
    if (!viewerPose) {
      console.log("[YOLO HIT DEBUG] No viewerPose; using fallback immediately");
      this.placeReticleFallback(originRef, dirRef);
      this.pendingRayRef = null;
      return;
    }

    const { originView, dirView } = this.rayRefSpaceToViewerSpace(
      originRef,
      dirRef,
      viewerPose,
    );

    const hitSession = session as XRSession & {
      requestHitTestSource?: (
        init: XRHitTestOptionsInit,
      ) => Promise<XRHitTestSource>;
    };

    if (!hitSession.requestHitTestSource) {
      console.warn("[YOLO HIT DEBUG] Hit-test API not available; fallback");
      this.placeReticleFallback(originRef, dirRef);
      this.pendingRayRef = null;
      return;
    }

    try {
      const xrRay = new XRRay(
        new DOMPointReadOnly(originView.x, originView.y, originView.z, 1),
        new DOMPointReadOnly(dirView.x, dirView.y, dirView.z, 0),
      );

      this.activeHitSource = await hitSession.requestHitTestSource({
        space: viewerSpace,
        offsetRay: xrRay,
      });
    } catch (e) {
      console.warn("[YOLO HIT DEBUG] requestHitTestSource failed; fallback", e);
      this.placeReticleFallback(originRef, dirRef);
      this.activeHitSource = null;
      this.pendingRayRef = null;
      this.timeSinceTap = 0;
    }
  }
}
