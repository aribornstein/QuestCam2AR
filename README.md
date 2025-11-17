# **Camera-Mapped Reticle Hit-Test System for WebXR**

This project implements a **real-time surface reticle** system in WebXR that allows users to point at objects in the physical world **by hovering over a live video panel** instead of using their headset’s actual view direction.

In other words:

> **You can look at a video feed panel inside VR, move a cursor over it, and the system projects that cursor back into the real room using hit-testing.**

The reticle then snaps to detected real-world surfaces (floor, walls, tables), just like the Meta “flower” demo — but driven by your **panel cursor**, not by your head or controller.

---

## ⭐ **What This Enables**

* A 2D panel becomes a **proxy camera view**, letting you raycast into the real world by hovering over the panel.
* A continuously updated **ring reticle** sits on whatever real-world surface corresponds to your panel cursor.
* The reticle **aligns to the surface normal**, not just position.
* The system keeps working while VR users move around.
* It functions as a **live calibration layer** between:

  * the Quest camera feed,
  * the panel display,
  * and WebXR’s world-space hit test surfaces.

This creates a **real-time manifold** where each pixel on the panel corresponds to a direction in physical space.

---

## 🧩 **Why This Was Built**

Most examples (Unity/ARKit/Meta Samples) rely on the device's true “view center” to perform hit-testing.
But this project required something different:

> **Hit-testing based on arbitrary UV coordinates on a virtual panel showing the headset’s camera feed.**

This is *not* provided by WebXR — we had to construct it manually by:

1. Letterboxing the camera feed into a square panel (maintaining aspect ratio).
2. Mapping panel UV → camera UV → clip space → world ray.
3. Transforming that ray into viewer space for XRHitTestSource.
4. Snapping a custom reticle mesh to the hit pose.

The result is a fully working **panel → room ray mapping pipeline**.

---

## ⚙️ **Key Components**

### **CameraPanelSystem**

* Renders the live camera feed onto a head-locked panel.
* Preserves aspect ratio using letterboxing (“A2 mode”).
* Emits mapping data (offsets, crop, dimensions) for ray reconstruction.

### **ControllerPanelTapSystem**

* Tracks controller ray intersection with the panel.
* Outputs continuous hover UV coordinates.
* Feeds these UVs into the hit-test system every frame.

### **TapHitDebugSystem (Reticle Version)**

* Converts panel UV → camera UV → NDC → world ray.
* Performs real WebXR hit tests using XRRay.
* Snaps a flat ring reticle onto real detected planes.
* Falls back to ray direction if hit tests fail.

---

## 🎯 **Current Goal**

Visually validate how accurately the panel cursor maps into real-world surfaces, and analyze where small systematic mismatches occur.
This will be used for:

* automated calibration,
* YOLO bounding-box projection,
* object selection via panel UI.

The reticle visualization makes it easy to see misalignment in real time.

---

## 🚀 **Future Extensions**

* Full YOLO integration for object detection based on panel clicks.
* Automatic calibration via regression fitting.
* QR/apriltag-based alignment (optional).
* Multi-camera stitching.

---

## 🧪 **Demo Behavior**

* Move the controller ray over the camera panel.
* Watch a blue ring reticle snap to the corresponding point in the real room.
* Move the controller → reticle continuously moves over actual surfaces.

If the reticle feels “off”, adjust calibration values or consider adding a mini training phase.

---

## 📝 **Status**

**Working prototype – reticle alignment mostly correct, testing ongoing.**
The system is functional enough to evaluate projection quality but it needs to be fixed the mapping isn't good enough.
