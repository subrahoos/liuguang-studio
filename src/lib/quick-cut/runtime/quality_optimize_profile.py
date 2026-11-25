from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np


SAMPLE_WIDTH = 360


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _progress(value: float, status: str) -> None:
    print(f"PROFILE|{value:.2f}|{status}", flush=True)


def _sample_frame(ffmpeg_path: Path, input_path: Path, second: float) -> np.ndarray:
    command = [
        str(ffmpeg_path),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{second:.6f}",
        "-i",
        str(input_path),
        "-frames:v",
        "1",
        "-vf",
        "scale=360:-2,format=rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    result = subprocess.run(command, capture_output=True)
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(detail or "frame extraction failed")
    pixel_count = len(result.stdout) // 3
    if pixel_count <= 0 or pixel_count * 3 != len(result.stdout) or pixel_count % SAMPLE_WIDTH:
        raise RuntimeError("sample frame has invalid RGB dimensions")
    height = pixel_count // SAMPLE_WIDTH
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(height, SAMPLE_WIDTH, 3)


def _measure_visual_profile(ffmpeg_path: Path, input_path: Path, duration: float) -> dict[str, float | int]:
    sample_count = 8 if duration > 90 else 6 if duration > 30 else 4
    sum_luma = 0.0
    sum_saturation = 0.0
    sum_red = 0.0
    sum_green = 0.0
    sum_blue = 0.0
    highlight = 0
    shadow = 0
    skin = 0
    pixel_total = 0

    for index in range(sample_count):
        second = max(0.05, duration * (index + 1) / (sample_count + 1.0))
        frame = _sample_frame(ffmpeg_path, input_path, second)
        step_x = max(4, frame.shape[1] // 80)
        step_y = max(4, frame.shape[0] // 80)
        samples = frame[::step_y, ::step_x].astype(np.float64)
        red = samples[:, :, 0] / 255.0
        green = samples[:, :, 1] / 255.0
        blue = samples[:, :, 2] / 255.0
        maximum = np.maximum(red, np.maximum(green, blue))
        minimum = np.minimum(red, np.minimum(green, blue))
        luma = 0.299 * red + 0.587 * green + 0.114 * blue
        saturation = np.where(maximum <= 0.001, 0.0, (maximum - minimum) / maximum)
        sum_luma += float(luma.sum())
        sum_saturation += float(saturation.sum())
        sum_red += float(red.sum())
        sum_green += float(green.sum())
        sum_blue += float(blue.sum())
        highlight += int((luma > 0.88).sum())
        shadow += int((luma < 0.12).sum())
        skin += int(((samples[:, :, 0] > 95)
          & (samples[:, :, 1] > 40)
          & (samples[:, :, 2] > 20)
          & (samples[:, :, 0] > samples[:, :, 1])
          & (samples[:, :, 0] > samples[:, :, 2])
          & (np.abs(samples[:, :, 0] - samples[:, :, 1]) > 15)).sum())
        pixel_total += int(samples.shape[0] * samples.shape[1])
        _progress(5 + (index + 1) * 13 / sample_count, f"SAMPLE_{index + 1}_OF_{sample_count}")

    if pixel_total <= 0:
        raise RuntimeError("visual profile has no sampled pixels")
    return {
        "avgLuma": sum_luma / pixel_total,
        "avgSaturation": sum_saturation / pixel_total,
        "avgR": sum_red / pixel_total,
        "avgG": sum_green / pixel_total,
        "avgB": sum_blue / pixel_total,
        "highlightRatio": highlight / pixel_total,
        "shadowRatio": shadow / pixel_total,
        "skinRatio": skin / pixel_total,
        "samples": sample_count,
    }


def _quality_profile(visual: dict[str, float | int]) -> dict[str, float | str]:
    average_luma = float(visual["avgLuma"])
    average_saturation = float(visual["avgSaturation"])
    highlight_ratio = float(visual["highlightRatio"])
    shadow_ratio = float(visual["shadowRatio"])
    skin_ratio = float(visual["skinRatio"])

    brightness = 0.0
    if average_luma < 0.42:
        brightness = _clamp((0.42 - average_luma) * 0.06, 0.002, 0.014)
    elif average_luma > 0.64 or highlight_ratio > 0.12:
        brightness = -_clamp(max(average_luma - 0.64, highlight_ratio - 0.12) * 0.035, 0.002, 0.008)

    contrast = 1.018
    if average_luma > 0.63 or highlight_ratio > 0.10:
        contrast = 1.006
    elif shadow_ratio > 0.22:
        contrast = 1.010
    elif 0.47 < average_luma < 0.58:
        contrast = 1.025

    saturation = 1.010
    if average_saturation < 0.22:
        saturation = 1.025
    elif average_saturation > 0.42:
        saturation = 1.000
    if skin_ratio > 0.08:
        saturation = min(saturation, 1.012)

    gamma = 1.0
    if shadow_ratio > 0.18 and highlight_ratio < 0.10:
        gamma = 0.992
    elif highlight_ratio > 0.14:
        gamma = 1.006

    average_red = float(visual["avgR"])
    average_green = float(visual["avgG"])
    average_blue = float(visual["avgB"])
    gray = (average_red + average_green + average_blue) / 3.0
    return {
        "brightness": brightness,
        "contrast": contrast,
        "saturation": saturation,
        "gamma": gamma,
        "rr": _clamp(1.0 + (gray - average_red) * 0.045, 0.992, 1.008),
        "gg": _clamp(1.0 + (gray - average_green) * 0.035, 0.994, 1.006),
        "bb": _clamp(1.0 + (gray - average_blue) * 0.045, 0.992, 1.008),
        "denoise": "hqdn3d=1.0:0.8:2.0:1.5" if average_luma < 0.40 or shadow_ratio > 0.20 else "hqdn3d=0.65:0.45:1.2:0.9",
        "sharpen": "unsharp=3:3:0.16:3:3:0.0" if average_luma > 0.68 or highlight_ratio > 0.16 else "unsharp=3:3:0.24:3:3:0.0",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Original quick-cut quality optimization visual profile")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--duration", type=float, required=True)
    args = parser.parse_args()
    try:
        _progress(3, "PREPARING")
        visual = _measure_visual_profile(args.ffmpeg.resolve(), args.input.resolve(), max(0.05, float(args.duration)))
        profile = _quality_profile(visual)
        _progress(20, "PROFILE_READY")
        print(json.dumps({"success": True, "visual": visual, "profile": profile}, ensure_ascii=True), flush=True)
    except Exception as error:
        print(json.dumps({"success": False, "message": str(error)}, ensure_ascii=True), flush=True)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
