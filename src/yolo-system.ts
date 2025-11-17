// yolo-system.ts — YOLO + WebXR hit-test labels for Quest 3 (plane-based depth)

import { createSystem, Types, CameraUtils } from "@iwsdk/core";
import * as THREE from "three";
import { Detection, getClassName } from "./yolo";

const INPUT_SIZE = 640;

// depth & label limits
const FALLBACK_DISTANCE = 2.0; // meters along camera ray
const MAX_LABELS = 5;
const MIN_SCORE_VISUAL = 0.35;

// tracking
const TRACK_TTL_SECONDS = 1.5; // how long a track can go unseen
const MAX_ASSOC_NORM_DIST = 0.12; // how far (in NDC) we still consider "same object"

// label visuals
const LABEL_WIDTH = 0.3;
const LABEL_HEIGHT = 0.08;

// FOV / visibility
const MIN_VIEW_DOT = 0.1; // hide if angle > ~84° off center

interface YoloTrack {
  id: number;
  classId: number;
  lastScore: number;
  lastSeenTime: number; // seconds since system start

  // last detection center in normalized [0..1] camera space
  cxNorm: number;
  cyNorm: number;

  // smoothed world position of the label
  worldPos: THREE.Vector3;

  // label mesh in the scene
  labelMesh: THREE.Mesh;
}

type Spaces = {
  session: XRSession;
  refSpace: XRReferenceSpace;
  viewerSpace: XRReferenceSpace;
};

export class YoloSystem extends createSystem(
  {},
  {
    interval: { type: Types.Float32, default: 0.35 }, // seconds between YOLO frames
  },
) {
  private accumTime = 0;
  private elapsedTime = 0;

  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  private labelGroup: THREE.Group | null = null;
  private tracks = new Map<number, YoloTrack>();
  private nextTrackId = 1;

  // cache for XR spaces (once a session exists)
  private spacesPromise: Promise<Spaces | null> | null = null;

  // single viewer-space hit-test source (like the flower demo)
  private viewerHitSource: XRHitTestSource | null = null;

  // last horizontal plane height derived from hit-test
  private lastHitPlaneY: number | null = null;

  // ---------------- UPDATE ----------------

  async update(dt: number, time: number) {
    if (this.isPaused) return;

    this.accumTime += dt;
    this.elapsedTime += dt;

    // billboards & visibility every frame
    this.updateBillboardsAndVisibility();

    const interval = this.config.interval.peek();
    if (this.accumTime < interval) return;
    this.accumTime = 0;

    const cameraEntity = this.globals.cameraEntity;
    const sendFrameToWorker = this.globals.sendFrameToWorker as
      | ((b: ImageBitmap) => void)
      | undefined;

    if (!cameraEntity || !sendFrameToWorker) {
      this.pruneExpiredTracks();
      return;
    }

    // 1) Capture frame & send to YOLO worker
    const frameCanvas: HTMLCanvasElement | null =
      CameraUtils.captureFrame?.(cameraEntity) ?? null;

    if (frameCanvas && typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(frameCanvas);
        sendFrameToWorker(bitmap);
      } catch (err) {
        console.warn("[YoloSystem] createImageBitmap failed:", err);
      }
    }

    // 2) Read latest detections from worker
    const allDets: Detection[] = this.globals.latestDetections ?? [];
    if (!allDets.length) {
      this.pruneExpiredTracks();
      return;
    }

    const dets = allDets
      .filter((d) => d.score >= MIN_SCORE_VISUAL)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_LABELS);

    if (!dets.length) {
      this.pruneExpiredTracks();
      return;
    }

    const frame = (this.xrFrame as XRFrame | null | undefined) ?? null;
    await this.updateTracksFromDetections(dets, frame, dt);
    this.pruneExpiredTracks();
  }

  // ---------------- label group ----------------

  private ensureLabelGroup(scene: THREE.Scene) {
    if (!this.labelGroup) {
      this.labelGroup = new THREE.Group();
      this.labelGroup.name = "YoloLabels";
      scene.add(this.labelGroup);
    }
  }

  // ---------------- XR helpers ----------------

  private async ensureSpaces(): Promise<Spaces | null> {
    const xrMgr: any = this.xrManager;
    const session: XRSession | null = xrMgr.getSession?.() ?? null;
    if (!session) return null; // no XR yet

    if (this.spacesPromise) return this.spacesPromise;

    this.spacesPromise = (async () => {
      const g = this.globals as any;

      // Try to reuse WebXRManager's refSpace if it exposes one
      let refSpace: XRReferenceSpace | null =
        xrMgr.getReferenceSpace?.() ?? null;

      if (!refSpace) {
        refSpace = await session.requestReferenceSpace("local-floor");
      }

      const viewerSpace = await session.requestReferenceSpace("viewer");

      g.refSpace = refSpace;
      g.viewerSpace = viewerSpace;

      return {
        session,
        refSpace,
        viewerSpace,
      };
    })();

    return this.spacesPromise;
  }

  // Single viewer hit-test source (no offsetRay) — same idea as flower demo
  private async ensureViewerHitTestSource(spaces: Spaces) {
    if (this.viewerHitSource) return;

    const hitSession = spaces.session as XRSession & {
      requestHitTestSource?: (
        init: XRHitTestOptionsInit,
      ) => Promise<XRHitTestSource>;
    };

    if (!hitSession.requestHitTestSource) {
      console.warn("[YoloSystem] Hit-test API not available on XRSession");
      return;
    }

    try {
      this.viewerHitSource = await hitSession.requestHitTestSource({
        space: spaces.viewerSpace,
      });
      console.log("[YOLO DEBUG] created default viewer hit-test source");
    } catch (e) {
      console.warn("[YoloSystem] requestHitTestSource(viewer) failed", e);
    }
  }

  // Use Three.js camera to build a world ray from NDC
  private getWorldRayFromNDC(
    xNdc: number,
    yNdc: number,
  ): { origin: THREE.Vector3; direction: THREE.Vector3 } {
    // THREE's Raycaster works with NDC and the current camera
    this.ndc.set(xNdc, yNdc);
    this.raycaster.setFromCamera(this.ndc, this.camera as THREE.PerspectiveCamera);

    const origin = this.raycaster.ray.origin.clone();
    const direction = this.raycaster.ray.direction.clone().normalize();

    return { origin, direction };
  }

  // Intersect a world ray with a horizontal plane y = lastHitPlaneY
  private intersectRayWithHitPlane(
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
  ): THREE.Vector3 | null {
    if (this.lastHitPlaneY == null) return null;

    const planeY = this.lastHitPlaneY;
    const dy = rayDir.y;

    // Ray is almost parallel to plane: skip
    if (Math.abs(dy) < 1e-4) return null;

    const t = (planeY - rayOrigin.y) / dy;
    if (t <= 0) return null; // intersection behind camera

    const hit = new THREE.Vector3();
    hit.copy(rayOrigin).add(rayDir.clone().multiplyScalar(t));
    return hit;
  }

  private computeFallbackWorldPos(
    ndcX: number,
    ndcY: number,
    camera: THREE.PerspectiveCamera,
  ): THREE.Vector3 {
    this.ndc.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.ndc, camera);

    const worldPos = new THREE.Vector3();
    this.raycaster.ray.at(FALLBACK_DISTANCE, worldPos);
    return worldPos;
  }

  private smoothTrackWorldPos(track: YoloTrack, newPos: THREE.Vector3) {
    const SMOOTH = 0.25; // 0..1, higher = snappier, lower = smoother
    track.worldPos.lerp(newPos, SMOOTH);
    track.labelMesh.position.copy(track.worldPos);
  }

  // ---------------- tracking logic ----------------

  private async updateTracksFromDetections(
    dets: Detection[],
    frame: XRFrame | null,
    dt: number,
  ) {
    const scene = this.scene as THREE.Scene;
    const camera = this.camera as THREE.PerspectiveCamera;

    this.ensureLabelGroup(scene);

    const availableTrackIds = new Set(this.tracks.keys());

    // Pre-fetch XR spaces if we have a frame
    const spaces = frame ? await this.ensureSpaces() : null;

    // --- Update our "depth plane" from viewer hit-test ---
    this.lastHitPlaneY = null;

    if (frame && spaces) {
      await this.ensureViewerHitTestSource(spaces);

      if (this.viewerHitSource) {
        const viewerHits = frame.getHitTestResults(this.viewerHitSource);
        console.log(
          "[YOLO DEBUG] default viewer hit-test has",
          viewerHits.length,
          "results this frame",
        );

        if (viewerHits.length > 0) {
          const hitPose = viewerHits[0].getPose(spaces.refSpace);
          if (hitPose) {
            const pos = hitPose.transform.position;
            this.lastHitPlaneY = pos.y;
            // Optional: log the plane height once in a while
            // console.log("[YOLO DEBUG] planeY =", this.lastHitPlaneY.toFixed(3));
          }
        }
      }
    }

    const debugGlobals = this.globals as any;
    debugGlobals.yoloLoggedThisFrame = false;

    for (const det of dets) {
      // Because we stretch the 1280x1080 frame into 640x640,
      // det.cx/det.cy / 640 give correct camera-normalized coords.
      const cxNorm = det.cx / INPUT_SIZE;
      const cyNorm = det.cy / INPUT_SIZE;

      const matchedId = this.findBestTrackMatch(
        det.classId,
        cxNorm,
        cyNorm,
        availableTrackIds,
      );

      // NDC for this detection
      const ndcX = cxNorm * 2 - 1;
      const ndcY = 1 - cyNorm * 2;

      // World ray from NDC
      const { origin, direction } = this.getWorldRayFromNDC(ndcX, ndcY);

      // Try to intersect with our horizontal plane
      let targetPos: THREE.Vector3 | null = null;
      if (this.lastHitPlaneY != null) {
        targetPos = this.intersectRayWithHitPlane(origin, direction);
      }

      // Fallback if no hit plane / bad intersection
      if (!targetPos) {
        targetPos = this.computeFallbackWorldPos(ndcX, ndcY, camera);
      }

      // --- DEBUG: log one sample per update ---
      if (!debugGlobals.yoloLoggedThisFrame) {
        console.log(
          "[YOLO DEBUG] det cx,cy:",
          det.cx.toFixed(1),
          det.cy.toFixed(1),
          "cxNorm,cyNorm:",
          cxNorm.toFixed(3),
          cyNorm.toFixed(3),
          "ray origin:",
          origin.x.toFixed(3),
          origin.y.toFixed(3),
          origin.z.toFixed(3),
          "dir:",
          direction.x.toFixed(3),
          direction.y.toFixed(3),
          direction.z.toFixed(3),
          "planeY:",
          this.lastHitPlaneY != null ? this.lastHitPlaneY.toFixed(3) : "none",
          "hitPos:",
          targetPos.x.toFixed(3),
          targetPos.y.toFixed(3),
          targetPos.z.toFixed(3),
        );
        debugGlobals.yoloLoggedThisFrame = true;
      }
      // --- end DEBUG ---

      if (matchedId != null) {
        // update existing track
        const track = this.tracks.get(matchedId)!;
        track.lastSeenTime = this.elapsedTime;
        track.lastScore = det.score;
        track.cxNorm = cxNorm;
        track.cyNorm = cyNorm;

        const text = this.buildLabelText(det);
        this.updateLabelMesh(track.labelMesh, text);

        this.smoothTrackWorldPos(track, targetPos);
        availableTrackIds.delete(matchedId);
      } else {
        // create a brand new track
        const text = this.buildLabelText(det);
        const labelMesh = this.createLabelMesh(text);
        labelMesh.position.copy(targetPos);
        this.labelGroup!.add(labelMesh);

        const track: YoloTrack = {
          id: this.nextTrackId++,
          classId: det.classId,
          lastScore: det.score,
          lastSeenTime: this.elapsedTime,
          cxNorm,
          cyNorm,
          worldPos: targetPos.clone(),
          labelMesh,
        };

        this.tracks.set(track.id, track);
      }
    }

    // reset per-update debug flag
    (this.globals as any).yoloLoggedThisFrame = false;
  }

  private findBestTrackMatch(
    classId: number,
    cxNorm: number,
    cyNorm: number,
    candidates: Set<number>,
  ): number | null {
    let bestId: number | null = null;
    let bestDist = Infinity;

    for (const id of candidates) {
      const t = this.tracks.get(id);
      if (!t) continue;
      if (t.classId !== classId) continue;

      const dx = t.cxNorm - cxNorm;
      const dy = t.cyNorm - cyNorm;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist && dist <= MAX_ASSOC_NORM_DIST) {
        bestDist = dist;
        bestId = id;
      }
    }

    return bestId;
  }

  private pruneExpiredTracks() {
    const now = this.elapsedTime;

    for (const [id, track] of this.tracks) {
      if (now - track.lastSeenTime > TRACK_TTL_SECONDS) {
        if (track.labelMesh && track.labelMesh.parent) {
          track.labelMesh.parent.remove(track.labelMesh);
        }

        this.tracks.delete(id);
      }
    }
  }

  // ---------------- label mesh helpers ----------------

  private buildLabelText(det: Detection): string {
    const name = getClassName(det.classId);
    return `${name} ${(det.score * 100).toFixed(1)}%`;
  }

  private createLabelMesh(text: string): THREE.Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 128;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // background
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // text
    ctx.fillStyle = "white";
    ctx.font = "40px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 20, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
    });

    const geometry = new THREE.PlaneGeometry(LABEL_WIDTH, LABEL_HEIGHT);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "YoloLabel";

    return mesh;
  }

  private updateLabelMesh(mesh: THREE.Mesh, text: string) {
    const material = mesh.material as THREE.MeshBasicMaterial;
    const texture = material.map as THREE.CanvasTexture;
    const canvas = texture.image as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = "white";
    ctx.font = "40px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 20, canvas.height / 2);

    texture.needsUpdate = true;
  }

  // ---------------- billboarding + FOV hiding ----------------

  private updateBillboardsAndVisibility() {
    if (!this.tracks.size) return;

    const camera = this.camera as THREE.PerspectiveCamera;

    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);

    const proj = new THREE.Vector3();

    for (const track of this.tracks.values()) {
      const mesh = track.labelMesh;
      const pos = track.worldPos;

      mesh.position.copy(pos);

      // billboard: face camera
      mesh.lookAt(camPos);

      // FOV hiding
      const toLabel = new THREE.Vector3().subVectors(pos, camPos).normalize();
      const dot = camDir.dot(toLabel);

      if (dot < MIN_VIEW_DOT) {
        mesh.visible = false;
        continue;
      }

      // project to NDC to check if within screen bounds
      proj.copy(pos);
      proj.project(camera);

      const inFrustum =
        proj.z > 0 && proj.z < 1 && Math.abs(proj.x) <= 1 && Math.abs(proj.y) <= 1;

      mesh.visible = inFrustum;
    }
  }
}
