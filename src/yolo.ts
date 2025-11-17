import * as ort from "onnxruntime-web";

const MODEL_URL = "/models/yolo11n.onnx";
const INPUT_SIZE = 640;

// ⚠️ Make sure this matches your package.json
const ORT_VERSION = "1.23.2";

let session: ort.InferenceSession | null = null;
let inputName: string | null = null;

// COCO 80-class names in the order Ultralytics uses
export const COCO_CLASS_NAMES: string[] = [
  "person",
  "bicycle",
  "car",
  "motorcycle",
  "airplane",
  "bus",
  "train",
  "truck",
  "boat",
  "traffic light",
  "fire hydrant",
  "stop sign",
  "parking meter",
  "bench",
  "bird",
  "cat",
  "dog",
  "horse",
  "sheep",
  "cow",
  "elephant",
  "bear",
  "zebra",
  "giraffe",
  "backpack",
  "umbrella",
  "handbag",
  "tie",
  "suitcase",
  "frisbee",
  "skis",
  "snowboard",
  "sports ball",
  "kite",
  "baseball bat",
  "baseball glove",
  "skateboard",
  "surfboard",
  "tennis racket",
  "bottle",
  "wine glass",
  "cup",
  "fork",
  "knife",
  "spoon",
  "bowl",
  "banana",
  "apple",
  "sandwich",
  "orange",
  "broccoli",
  "carrot",
  "hot dog",
  "pizza",
  "donut",
  "cake",
  "chair",
  "couch",
  "potted plant",
  "bed",
  "dining table",
  "toilet",
  "tv",
  "laptop",
  "mouse",
  "remote",
  "keyboard",
  "cell phone",
  "microwave",
  "oven",
  "toaster",
  "sink",
  "refrigerator",
  "book",
  "clock",
  "vase",
  "scissors",
  "teddy bear",
  "hair drier",
  "toothbrush",
];

export function getClassName(classId: number): string {
  if (classId >= 0 && classId < COCO_CLASS_NAMES.length) {
    return COCO_CLASS_NAMES[classId];
  }
  return `class_${classId}`;
}

export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
  score: number;
  classId: number;
}

export async function initYolo() {
  if (session) return;

  ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

  session = await ort.InferenceSession.create(MODEL_URL, {
    executionProviders: ["wasm"],
  });

  inputName = session.inputNames[0];
}

export function getYoloSession() {
  if (!session || !inputName) {
    throw new Error("YOLO session not initialized. Call initYolo() first.");
  }
  return { session, inputName };
}

// --- Preprocess: camera frame canvas → 640x640 tensor ---

let preprocessCanvas: HTMLCanvasElement | null = null;
let preprocessCtx: CanvasRenderingContext2D | null = null;

function getPreprocessContext(): CanvasRenderingContext2D {
  if (!preprocessCanvas) {
    preprocessCanvas = document.createElement("canvas");
    preprocessCanvas.width = INPUT_SIZE;
    preprocessCanvas.height = INPUT_SIZE;
    preprocessCtx = preprocessCanvas.getContext("2d");
    if (!preprocessCtx) {
      throw new Error("Failed to get 2D context for preprocess canvas");
    }
  }
  if (!preprocessCtx) {
    const ctx = preprocessCanvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to restore 2D context for preprocess canvas");
    }
    preprocessCtx = ctx;
  }
  return preprocessCtx;
}

// Takes a full-res canvas from CameraUtils.captureFrame(cameraEntity)
// and produces a [1,3,640,640] float32 tensor normalized to [0,1].
export function makeInputTensorFromCanvas(
  frameCanvas: HTMLCanvasElement,
): ort.Tensor {
  const ctx = getPreprocessContext();

  // Scale/crop entire frame into 640x640
  ctx.drawImage(frameCanvas, 0, 0, INPUT_SIZE, INPUT_SIZE);

  const imageData = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE);
  const data = imageData.data; // RGBA

  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;

    const x = p % INPUT_SIZE;
    const y = Math.floor(p / INPUT_SIZE);
    const base = y * INPUT_SIZE + x;

    chw[0 * INPUT_SIZE * INPUT_SIZE + base] = r;
    chw[1 * INPUT_SIZE * INPUT_SIZE + base] = g;
    chw[2 * INPUT_SIZE * INPUT_SIZE + base] = b;
  }

  return new ort.Tensor("float32", chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
}

// --- IoU + NMS + postprocess ---

function iou(a: Detection, b: Detection): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);

  const interW = Math.max(0, x2 - x1);
  const interH = Math.max(0, y2 - y1);
  const interArea = interW * interH;

  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - interArea;

  if (union <= 0) return 0;
  return interArea / union;
}

function nms(dets: Detection[], iouThreshold: number): Detection[] {
  const result: Detection[] = [];
  const sorted = [...dets].sort((a, b) => b.score - a.score);

  while (sorted.length > 0) {
    const best = sorted.shift()!;
    result.push(best);

    for (let i = sorted.length - 1; i >= 0; i--) {
      if (iou(best, sorted[i]) > iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }

  return result;
}

// YOLO11n ONNX output [1,84,8400] → Detection[]
export function postprocessDetections(
  output: ort.Tensor,
  confThreshold = 0.25,
  iouThreshold = 0.45,
): Detection[] {
  const data = output.data as Float32Array;
  const dims = output.dims;

  if (dims.length !== 3) {
    console.warn("Unexpected YOLO output dims", dims);
    return [];
  }

  const [batch, channels, numDet] = dims;
  if (batch !== 1) {
    console.warn("Only batch 1 supported, got", batch);
    return [];
  }

  const numClasses = channels - 4;
  const dets: Detection[] = [];

  for (let i = 0; i < numDet; i++) {
    const cx = data[0 * numDet + i];
    const cy = data[1 * numDet + i];
    const w = data[2 * numDet + i];
    const h = data[3 * numDet + i];

    let bestClass = -1;
    let bestScore = -Infinity;

    for (let c = 0; c < numClasses; c++) {
      const score = data[(4 + c) * numDet + i];
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestScore < confThreshold) continue;

    const x = cx - w / 2;
    const y = cy - h / 2;

    dets.push({
      x,
      y,
      w,
      h,
      cx,
      cy,
      score: bestScore,
      classId: bestClass,
    });
  }

  return nms(dets, iouThreshold);
}
