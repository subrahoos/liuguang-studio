"""Local fashion-shot analyzer used by 3100 quick-cut.

The Node worker invokes this script only when the isolated runtime contains
models and a READY.json marker. It never downloads models during a user task.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import hashlib
from collections import OrderedDict
from pathlib import Path
from typing import Any


ROLE_PROMPTS = {
    "opening-full-body": "an opening vertical fashion shot clearly showing the complete outfit and full body",
    "fabric-detail": "a close fashion shot emphasizing fabric texture, neckline, sleeve, stitching, or garment detail",
    "slimming-silhouette": "a fashion shot clearly showing the garment silhouette, waist line, body proportion, or slimming fit",
    "wearing-effect": "a front fashion shot showing how the complete garment looks when worn",
    "movement-drape": "a fashion shot showing walking, turning, skirt movement, fabric flow, or drape",
    "side-back": "a fashion shot clearly showing the side view or back view of the outfit",
    "closing-pose": "a closing fashion shot with a stable final pose or complete outfit hold",
    "unclassified": "a vertical fashion video frame that is not a clear outfit presentation",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--pose-backend", choices=("auto", "mmpose", "rtmpose"), default="auto")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def resolve_model_path(value: Any, model_root: Path, fallback: Path) -> Path | None:
    """Allow a verified runtime to move without keeping D:\\3100 absolute paths."""
    candidate = Path(str(value)) if value else fallback
    if candidate.exists():
        return candidate
    return fallback if fallback.exists() else None


def sample_times(start: float, end: float) -> list[float]:
    duration = max(0.0, end - start)
    inset = min(0.12, duration / 5.0)
    left = start + inset
    right = max(left, end - inset)
    middle = (left + right) / 2.0
    count = 3 if duration < 1.5 else 5 if duration <= 4 else 7 if duration <= 8 else 9
    return sorted({round(left + (right - left) * index / (count - 1), 3) for index in range(count)})


class FrameReader:
    """One decoder per source; retain a bounded number of decoded frames."""
    def __init__(self, video_path: str) -> None:
        import cv2
        self.capture = cv2.VideoCapture(video_path)
        self.cache: OrderedDict[float, Any] = OrderedDict()
        self.decoded = 0
        self.cache_hits = 0

    def read(self, timestamps: list[float]) -> list[tuple[float, Any]]:
        import cv2
        result = []
        for timestamp in timestamps:
            if timestamp in self.cache:
                frame = self.cache[timestamp]
                self.cache.move_to_end(timestamp)
                self.cache_hits += 1
            else:
                self.capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
                ok, frame = self.capture.read()
                if not ok or frame is None:
                    continue
                height, width = frame.shape[:2]
                scale = min(1.0, 960.0 / max(height, width))
                if scale < 1:
                    frame = cv2.resize(frame, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
                self.decoded += 1
                self.cache[timestamp] = frame
                if len(self.cache) > 16:
                    self.cache.popitem(last=False)
            result.append((timestamp, frame))
        return result

    def close(self) -> None:
        self.capture.release()
        self.cache.clear()


class FashionScorer:
    """Encode the shared role text once; bound image inference to 8 frames."""
    def __init__(self, model: Any, processor: Any, device: str) -> None:
        import torch
        self.model, self.processor, self.device = model, processor, device
        text = [ROLE_PROMPTS[label] for label in ROLE_PROMPTS]
        inputs = processor(text=text, return_tensors="pt", padding=True)
        inputs = {key: value.to(device) for key, value in inputs.items()}
        with torch.inference_mode():
            text_outputs = model.text_model(**inputs)
            self.text_features = model.text_projection(text_outputs.pooler_output)
            self.text_features = self.text_features / self.text_features.norm(dim=-1, keepdim=True)
        self.image_batches = 0

    def score(self, frames: list[Any]) -> dict[str, float]:
        import torch
        from PIL import Image
        probabilities = []
        for offset in range(0, len(frames), 8):
            images = [Image.fromarray(frame[:, :, ::-1]) for frame in frames[offset:offset + 8]]
            inputs = self.processor(images=images, return_tensors="pt")
            with torch.inference_mode():
                output = self.model.vision_model(pixel_values=inputs["pixel_values"].to(self.device))
                features = self.model.visual_projection(output.pooler_output)
                features = features / features.norm(dim=-1, keepdim=True)
                logits = self.model.logit_scale.exp() * features @ self.text_features.T
                probabilities.append(logits.softmax(dim=-1).cpu())
            self.image_batches += 1
        values = torch.cat(probabilities).mean(dim=0).tolist()
        return {label: float(value) for label, value in zip(ROLE_PROMPTS, values)}


class RTMPoseAdapter:
    backend = "RTMPose-s / ONNX CPU"

    def __init__(self, model_root: Path, config: dict[str, Any]) -> None:
        packages = model_root.parent / "rtmpose-packages"
        if packages.is_dir():
            sys.path.insert(0, str(packages))
        from rtmlib import RTMPose
        checkpoint = model_root / config["path"]
        if not checkpoint.is_file():
            raise RuntimeError("RTMPose 本地权重缺失")
        expected = config.get("sha256", "").lower()
        if not expected or hashlib.sha256(checkpoint.read_bytes()).hexdigest() != expected:
            raise RuntimeError("RTMPose 本地权重校验失败")
        self.model = RTMPose(str(checkpoint), model_input_size=(192, 256), backend="onnxruntime", device="cpu")

    def __call__(self, frame: Any, **kwargs: Any) -> Any:
        points, scores = self.model(frame)
        yield {"predictions": [[{"keypoints": point.tolist(), "keypoint_scores": score.tolist()}
                                 for point, score in zip(points, scores)]]}


def read_frames(video_path: str, timestamps: list[float]) -> list[Any]:
    import cv2

    capture = cv2.VideoCapture(video_path)
    frames = []
    try:
        for timestamp in timestamps:
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = capture.read()
            if ok and frame is not None:
                frames.append(frame)
    finally:
        capture.release()
    return frames


def fashion_scores(model: Any, processor: Any, frames: list[Any], device: str) -> dict[str, float]:
    import torch
    from PIL import Image

    labels = list(ROLE_PROMPTS)
    text = [ROLE_PROMPTS[label] for label in labels]
    images = [Image.fromarray(frame[:, :, ::-1]) for frame in frames]
    inputs = processor(text=text, images=images, return_tensors="pt", padding=True)
    inputs = {key: value.to(device) for key, value in inputs.items()}
    with torch.no_grad():
        logits = model(**inputs).logits_per_image
        values = logits.softmax(dim=1).mean(dim=0).detach().cpu().tolist()
    return {label: float(value) for label, value in zip(labels, values)}


def install_mmcv_cpu_compat() -> None:
    """Provide the unused mmcv CUDA symbols needed by MMPose imports.

    The HRNet top-down model does not use deformable attention or deformable
    convolutions, but MMPose imports those optional heads eagerly. The runtime
    intentionally uses mmcv-lite on Windows, so keep this compatibility layer
    local to the fashion-vision process instead of changing the main app or
    requiring a native CUDA build.
    """
    import sys
    import types
    import torch.nn as nn

    if "mmcv.ops" in sys.modules:
        return

    class OptionalOp(nn.Module):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__()

        def forward(self, *args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("当前 fashion-vision 模型未启用 mmcv CUDA 扩展")

    def unavailable_op(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("当前 fashion-vision 模型未启用 mmcv CUDA 扩展")

    ops = types.ModuleType("mmcv.ops")
    ops.__path__ = []
    ops.MultiScaleDeformableAttention = OptionalOp
    ops.DeformConv2d = OptionalOp
    ops.ModulatedDeformConv2d = OptionalOp
    ops.deform_conv2d = unavailable_op
    ops.modulated_deform_conv2d = unavailable_op
    ops.nms = unavailable_op
    ops.batched_nms = unavailable_op
    ops.multiclass_nms = unavailable_op
    sys.modules["mmcv.ops"] = ops

    deform_attn = types.ModuleType("mmcv.ops.multi_scale_deform_attn")
    deform_attn.MultiScaleDeformableAttention = OptionalOp
    sys.modules["mmcv.ops.multi_scale_deform_attn"] = deform_attn
    deform_conv = types.ModuleType("mmcv.ops.deform_conv")
    deform_conv.DeformConv2d = OptionalOp
    deform_conv.deform_conv2d = unavailable_op
    sys.modules["mmcv.ops.deform_conv"] = deform_conv
    modulated_deform_conv = types.ModuleType("mmcv.ops.modulated_deform_conv")
    modulated_deform_conv.ModulatedDeformConv2d = OptionalOp
    modulated_deform_conv.modulated_deform_conv2d = unavailable_op
    sys.modules["mmcv.ops.modulated_deform_conv"] = modulated_deform_conv
    nms_module = types.ModuleType("mmcv.ops.nms")
    nms_module.nms = unavailable_op
    nms_module.batched_nms = unavailable_op
    nms_module.multiclass_nms = unavailable_op
    sys.modules["mmcv.ops.nms"] = nms_module


def allow_trusted_mmpose_checkpoint_load() -> None:
    """Keep MMPose 1.x compatible with PyTorch 2.6+ local checkpoints."""
    import torch

    if getattr(torch.load, "_luma_mmpose_compat", False):
        return
    original_load = torch.load

    def load_checkpoint(*args: Any, **kwargs: Any) -> Any:
        kwargs.setdefault("weights_only", False)
        return original_load(*args, **kwargs)

    load_checkpoint._luma_mmpose_compat = True
    torch.load = load_checkpoint


def create_pose_inferencer(model_root: Path, device: str, backend: str = "auto") -> Any:
    """Load the local MMPose model once for the whole analysis task."""
    ready = load_json(model_root / "READY.json")
    preferred = ready.get("poseBackend", "mmpose") if backend == "auto" else backend
    if preferred == "rtmpose":
        try:
            return RTMPoseAdapter(model_root, ready.get("rtmpose") or {})
        except Exception:
            if backend == "rtmpose":
                raise
    pose = ready.get("mmpose") or {}
    model = pose.get("model") or pose.get("config")
    checkpoint = resolve_model_path(
        pose.get("checkpoint"),
        model_root,
        model_root / "mmpose" / Path(str(pose.get("checkpoint") or "checkpoint.pth")).name,
    )
    if not model or checkpoint is None:
        return None
    allow_trusted_mmpose_checkpoint_load()
    install_mmcv_cpu_compat()
    from mmpose.apis import MMPoseInferencer

    return MMPoseInferencer(
        pose2d=str(model),
        pose2d_weights=str(checkpoint),
        det_model="whole_image",
        device=device,
    )


COCO_UPPER_BODY = (5, 6, 7, 8, 9, 10)
COCO_LOWER_BODY = (11, 12, 13, 14, 15, 16)
POSE_CONFIDENCE = 0.25


def as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if hasattr(value, "tolist"):
        value = value.tolist()
    return list(value) if isinstance(value, (list, tuple)) else []


def point_distance(left: tuple[float, float], right: tuple[float, float]) -> float:
    return math.hypot(left[0] - right[0], left[1] - right[1])


def point_midpoint(left: tuple[float, float], right: tuple[float, float]) -> tuple[float, float]:
    return ((left[0] + right[0]) / 2.0, (left[1] + right[1]) / 2.0)


def normalize_prediction(item: dict[str, Any], frame_size: tuple[int, int] | None = None) -> dict[str, Any] | None:
    raw_points = as_list(item.get("keypoints"))
    raw_scores = as_list(item.get("keypoint_scores")) or as_list(item.get("keypoints_visible"))
    points: list[tuple[float, float] | None] = []
    scores: list[float] = []
    for index in range(17):
        point = raw_points[index] if index < len(raw_points) else None
        score = raw_scores[index] if index < len(raw_scores) else 0.0
        try:
            score_value = float(score)
        except (TypeError, ValueError):
            score_value = 0.0
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                x, y = float(point[0]), float(point[1])
                points.append((x, y))
                if not math.isfinite(x) or not math.isfinite(y) or (frame_size and not (0 <= x < frame_size[0] and 0 <= y < frame_size[1])):
                    score_value = 0.0
            except (TypeError, ValueError):
                points.append(None)
        else:
            points.append(None)
        scores.append(score_value)
    visible = [index for index, point in enumerate(points) if point is not None and scores[index] >= POSE_CONFIDENCE]
    if not visible:
        return None
    upper_visible = sum(1 for index in COCO_UPPER_BODY if index in visible)
    lower_visible = sum(1 for index in COCO_LOWER_BODY if index in visible)
    confidence = sum(scores[index] for index in visible) / len(visible)
    completeness = (
        0.35 * (len(visible) / 17.0)
        + 0.30 * (upper_visible / len(COCO_UPPER_BODY))
        + 0.35 * (lower_visible / len(COCO_LOWER_BODY))
    )
    if upper_visible >= 4 and lower_visible >= 4:
        body_frame = "full-body"
    elif upper_visible >= 4 and lower_visible >= 2:
        body_frame = "three-quarter"
    elif upper_visible >= 3:
        body_frame = "upper-body"
    else:
        body_frame = "partial"

    shoulders = points[5], points[6]
    hips = points[11], points[12]
    orientation = "unknown"
    body_height = 0.0
    if all(index in visible for index in (5, 6, 11, 12)):
        shoulder_mid = point_midpoint(shoulders[0], shoulders[1])  # type: ignore[arg-type]
        hip_mid = point_midpoint(hips[0], hips[1])  # type: ignore[arg-type]
        body_height = max(1.0, point_distance(shoulder_mid, hip_mid))
        body_width = (point_distance(shoulders[0], shoulders[1]) + point_distance(hips[0], hips[1])) / 2.0  # type: ignore[arg-type]
        orientation = "side-back" if body_width / body_height < 0.58 else "front"
    else:
        visible_points = [points[index] for index in visible if points[index] is not None]
        xs = [point[0] for point in visible_points]  # type: ignore[index]
        ys = [point[1] for point in visible_points]  # type: ignore[index]
        if xs and ys:
            body_height = max(1.0, max(ys) - min(ys))

    center_points = [points[index] for index in (5, 6, 11, 12) if points[index] is not None and scores[index] >= POSE_CONFIDENCE]
    if not center_points:
        center_points = [points[index] for index in visible if points[index] is not None]
    center = (
        sum(point[0] for point in center_points) / len(center_points),  # type: ignore[index]
        sum(point[1] for point in center_points) / len(center_points),  # type: ignore[index]
    )
    return {
        "points": points,
        "visible": visible,
        "bodyHeight": body_height,
        "center": center,
        "completeness": completeness,
        "confidence": confidence,
        "bodyFrame": body_frame,
        "orientation": orientation,
    }


def motion_strength(samples: list[dict[str, Any]]) -> float:
    distances: list[float] = []
    for previous, current in zip(samples, samples[1:]):
        scale = max(1.0, (float(previous["bodyHeight"]) + float(current["bodyHeight"])) / 2.0)
        elapsed = max(0.05, float(current.get("timestamp", 1.5)) - float(previous.get("timestamp", 0)))
        time_factor = 1.5 / elapsed
        shared = set(previous["visible"]) & set(current["visible"])
        for index in shared:
            left = previous["points"][index]
            right = current["points"][index]
            if left is not None and right is not None:
                distances.append(point_distance(left, right) / scale * time_factor)
        distances.append(point_distance(previous["center"], current["center"]) / scale * time_factor)
    return min(1.0, sum(distances) / len(distances)) if distances else 0.0


def pose_summary(frames: list[Any], inferencer: Any, timestamps: list[float] | None = None) -> dict[str, Any]:
    """Use the task-scoped MMPose instance for keypoint-assisted filtering.

    The pose layer is intentionally optional: FashionCLIP remains useful on
    machines that have not installed the larger pose checkpoint yet.
    """
    if inferencer is None:
        return {"available": False, "personFrames": 0, "keypointFrames": 0, "reason": "MMPose 未加载"}
    try:
        keypoint_frames = 0
        person_frames = 0
        frame_poses: list[dict[str, Any]] = []
        for frame_index, frame in enumerate(frames):
            result = next(iter(inferencer(frame, return_vis=False)))
            predictions = result.get("predictions") or []
            if predictions and isinstance(predictions[0], list):
                predictions = predictions[0]
            if predictions:
                person_frames += 1
                keypoint_frames += sum(
                    1 for item in predictions
                    if item.get("keypoints")
                )
                normalized = [normalize_prediction(item, (frame.shape[1], frame.shape[0])) for item in predictions]
                candidates = [item for item in normalized if item is not None]
                if candidates:
                    chosen = max(candidates, key=lambda item: item["completeness"])
                    chosen["timestamp"] = timestamps[frame_index] if timestamps else frame_index * 1.5
                    frame_poses.append(chosen)
        if not frame_poses:
            return {"available": True, "personFrames": person_frames, "keypointFrames": keypoint_frames, "personRatio": 0.0, "completeness": 0.0, "bodyFrame": "partial", "orientation": "unknown", "motionMagnitude": 0.0, "stability": 0.0}
        body_frames = [item["bodyFrame"] for item in frame_poses]
        orientations = [item["orientation"] for item in frame_poses if item["orientation"] != "unknown"]
        motion = motion_strength(frame_poses)
        return {
            "available": True,
            "personFrames": person_frames,
            "keypointFrames": keypoint_frames,
            "personRatio": round(person_frames / max(1, len(frames)), 4),
            "completeness": round(sum(item["completeness"] for item in frame_poses) / len(frame_poses), 4),
            "confidence": round(sum(item["confidence"] for item in frame_poses) / len(frame_poses), 4),
            "bodyFrame": max(set(body_frames), key=body_frames.count),
            "orientation": max(set(orientations), key=orientations.count) if orientations else "unknown",
            "motionMagnitude": round(motion, 4),
            "stability": round(max(0.0, 1.0 - min(1.0, motion / 0.22)), 4),
        }
    except Exception as error:
        return {"available": False, "personFrames": 0, "keypointFrames": 0, "reason": str(error)[:120]}


def apply_pose_evidence(scores: dict[str, float], pose: dict[str, Any]) -> dict[str, float]:
    adjusted = dict(scores)
    if not pose.get("available"):
        return adjusted
    frame = str(pose.get("bodyFrame") or "partial")
    orientation = str(pose.get("orientation") or "unknown")
    motion = float(pose.get("motionMagnitude") or 0.0)
    stability = float(pose.get("stability") or 0.0)
    if frame == "full-body":
        adjusted["opening-full-body"] += 0.10
        adjusted["wearing-effect"] += 0.06
        adjusted["slimming-silhouette"] += 0.05
    elif frame == "upper-body":
        adjusted["fabric-detail"] += 0.08
    if orientation == "side-back" and scores["side-back"] >= scores["wearing-effect"]:
        adjusted["side-back"] += 0.12
    if motion >= 0.055:
        adjusted["movement-drape"] += min(0.12, motion * 0.8)
    if frame == "full-body" and stability >= 0.7:
        adjusted["closing-pose"] += 0.05
    return {label: min(1.0, value) for label, value in adjusted.items()}


def classify_shot(shot: dict[str, Any], model: Any, processor: Any, pose_inferencer: Any, device: str,
                  *, reader: FrameReader | None = None, scorer: FashionScorer | None = None) -> dict[str, Any]:
    start = float(shot.get("start") or 0.0)
    end = float(shot.get("end") or start + float(shot.get("duration") or 0.0))
    times = sample_times(start, end)
    if reader is not None:
        samples = reader.read(times)
        times, frames = [item[0] for item in samples], [item[1] for item in samples]
    else:
        frames = read_frames(str(shot["path"]), times)
    if not frames:
        return {
            "shotId": shot["id"],
            "usable": False,
            "fashionRole": "unclassified",
            "fashionScore": 0.0,
            "labels": [],
            "safeStart": start,
            "safeDuration": 0.0,
            "burnedTextRisk": True,
        }

    scores = scorer.score(frames) if scorer else fashion_scores(model, processor, frames, device)
    pose = pose_summary(frames, pose_inferencer, times)
    adjusted_scores = apply_pose_evidence(scores, pose)
    role = max((label for label in ROLE_PROMPTS if label != "unclassified"), key=lambda label: adjusted_scores[label])
    best_score = adjusted_scores[role]
    raw_best_score = scores[role]
    person_ratio = float(pose.get("personRatio") or 0.0) if pose["available"] else 1.0
    pose_complete = not pose["available"] or float(pose.get("completeness") or 0.0) >= 0.35
    usable = raw_best_score >= 0.13 and best_score >= 0.16 and best_score >= scores["unclassified"] * 0.9 and person_ratio >= 0.5 and pose_complete
    duration = max(0.0, end - start)
    safe_duration = min(3.3, max(0.0, duration - min(0.2, duration / 5.0)))
    return {
        "shotId": shot["id"],
        "usable": usable,
        "fashionRole": role if usable else "unclassified",
        "fashionScore": round(float(best_score), 4),
        "labels": sorted(adjusted_scores, key=adjusted_scores.get, reverse=True)[:3],
        "roleScores": {label: round(float(value), 4) for label, value in scores.items()},
        "roleAdjustedScores": {label: round(float(value), 4) for label, value in adjusted_scores.items()},
        "poseEvidenceUsed": bool(pose.get("available")),
        "safeStart": round(start + min(0.12, duration / 5.0), 3),
        "safeDuration": round(safe_duration, 3),
        "burnedTextRisk": False,
        "pose": pose,
        "sampleCount": len(frames),
    }


def main() -> None:
    started = time.perf_counter()
    args = parse_args()
    input_data = load_json(Path(args.input))
    model_root = Path(args.model_root)
    ready = load_json(model_root / "READY.json")
    fashion_model_path = resolve_model_path(
        ready.get("fashionclip", {}).get("path"),
        model_root,
        model_root / "fashionclip",
    )
    if fashion_model_path is None:
        raise RuntimeError("READY.json 未配置 FashionCLIP 模型路径")

    import torch
    from transformers import CLIPModel, CLIPProcessor

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = CLIPModel.from_pretrained(str(fashion_model_path), local_files_only=True).to(device)
    processor = CLIPProcessor.from_pretrained(str(fashion_model_path), local_files_only=True)
    model.eval()
    try:
        pose_inferencer = create_pose_inferencer(model_root, device, args.pose_backend)
    except Exception:
        pose_inferencer = None

    model_usage = {
        "device": device,
        "fashionclip": {"loaded": True, "rolePromptCount": len(ROLE_PROMPTS) - 1},
        "mmpose": {"loaded": pose_inferencer is not None and not isinstance(pose_inferencer, RTMPoseAdapter)},
        "pose": {"loaded": pose_inferencer is not None,
                 "backend": getattr(pose_inferencer, "backend", "MMPose HRNet-W32") if pose_inferencer else "unavailable"},
    }
    print(f"LUMA_FASHION_MODEL:{json.dumps(model_usage, ensure_ascii=False)}", flush=True)

    annotations = []
    candidates = [
        (source, shot)
        for source in input_data.get("sources", [])
        for shot in source.get("shots", [])
    ]
    total = len(candidates)
    scorer = FashionScorer(model, processor, device)
    decode_count = cache_hits = source_count = 0
    index = 0
    for source in input_data.get("sources", []):
        reader = FrameReader(source["path"])
        source_count += 1
        try:
            for shot in source.get("shots", []):
                annotations.append(classify_shot(
                    {**shot, "path": source["path"]}, model, processor, pose_inferencer, device,
                    reader=reader, scorer=scorer,
                ))
                index += 1
                print(f"LUMA_FASHION_PROGRESS:{index}:{total}", flush=True)
        finally:
            decode_count += reader.decoded
            cache_hits += reader.cache_hits
            reader.close()

    usable = [item for item in annotations if item.get("usable")]
    pose_available = [item for item in annotations if item.get("pose", {}).get("available")]
    model_usage["pose"].update({
        "poseCandidateCount": len(pose_available),
        "fullBodyCount": sum(1 for item in pose_available if item.get("pose", {}).get("bodyFrame") == "full-body"),
        "motionCandidateCount": sum(1 for item in pose_available if float(item.get("pose", {}).get("motionMagnitude") or 0.0) >= 0.055),
    })
    if model_usage["mmpose"]["loaded"]:
        model_usage["mmpose"].update(model_usage["pose"])
    model_usage["roleCounts"] = {
        label: sum(1 for item in usable if item.get("fashionRole") == label)
        for label in ROLE_PROMPTS
        if label != "unclassified"
    }
    model_usage["performance"] = {
        "elapsedSeconds": round(time.perf_counter() - started, 3),
        "textEncodeCount": 1, "imageBatchCount": scorer.image_batches,
        "decodedFrameCount": decode_count, "frameCacheHits": cache_hits, "decoderOpenCount": source_count,
        "sampleCount": sum(item.get("sampleCount", 0) for item in annotations),
    }
    Path(args.output).write_text(
        json.dumps({"device": device, "modelUsage": model_usage, "annotations": annotations}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
