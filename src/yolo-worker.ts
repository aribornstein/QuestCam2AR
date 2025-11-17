// yolo-worker.ts — FULL FILE, reusing your yolo.ts helpers

import * as ort from "onnxruntime-web";
import {
  initYolo,
  getYoloSession,
  postprocessDetections,
  Detection,
} from "./yolo";

let ready = false;

console.log("[YOLO Worker] Booting…");

(async () => {
  try {
    console.log("[YOLO Worker] Calling initYolo()…");
    await initYolo(); // uses your MODEL_URL + ORT_VERSION + wasmPaths (CDN)
    const { session, inputName } = getYoloSession();
    console.log(
      "[YOLO Worker] Model loaded, input:",
      inputName,
      "outputs:",
      session.outputNames,
    );
    ready = true;
  } catch (err) {
    console.error("[YOLO Worker] Failed to init YOLO:", err);
    ready = false;
  }
})();

// Preprocess ImageBitmap → 1×3×640×640 float32 tensor (same resizing as makeInputTensorFromCanvas)
async function preprocessBitmap(bitmap: ImageBitmap): Promise<ort.Tensor> {
  const SIZE = 640;

  const off = new OffscreenCanvas(SIZE, SIZE);
  const ctx = off.getContext("2d");
  if (!ctx) {
    throw new Error("[YOLO Worker] Failed to get 2D context on OffscreenCanvas");
  }

  // Draw full bitmap scaled into 640×640
  ctx.drawImage(bitmap, 0, 0, SIZE, SIZE);

  const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
  const data = imageData.data; // RGBA

  const chw = new Float32Array(3 * SIZE * SIZE);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const x = p % SIZE;
    const y = Math.floor(p / SIZE);
    const base = y * SIZE + x;

    chw[0 * SIZE * SIZE + base] = r;
    chw[1 * SIZE * SIZE + base] = g;
    chw[2 * SIZE * SIZE + base] = b;
  }

  return new ort.Tensor("float32", chw, [1, 3, SIZE, SIZE]);
}

// Worker message handler
self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg || msg.type !== "frame") return;

  const bitmap: ImageBitmap = msg.bitmap;
  const frameId: number = msg.frameId;

  if (!ready) {
    // Model isn’t ready yet; drop frame
    bitmap.close();
    return;
  }

  try {
    const input = await preprocessBitmap(bitmap);

    const { session, inputName } = getYoloSession();
    const outputs = await session.run({ [inputName]: input });
    const outputName = session.outputNames[0];
    const out = outputs[outputName];

    const dets: Detection[] = postprocessDetections(out);

    (self as any).postMessage({
      type: "detections",
      detections: dets,
      frameId,
    });
  } catch (err) {
    console.error("[YOLO Worker] Error during inference:", err);
  } finally {
    bitmap.close();
  }
};
