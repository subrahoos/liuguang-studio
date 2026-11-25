from __future__ import annotations

import argparse
import binascii
import hashlib
import json
import logging
import math
import mmap
import os
import random
import re
import subprocess
import sys
import threading
import zlib
from pathlib import Path

import numpy as np


logger = logging.getLogger(__name__)
VIDEO_PROCESS_STATUS = {
    "START": "START",
    "WATERMARK": "WATERMARK",
    "ENCODE": "ENCODE",
    "DONE": "DONE",
}

STOP_FLAG = False
WATERMARK_INTERVAL = 12
WATERMARK_BLOCK_SIZE = 32
WATERMARK_QIM_STEP = 34.0
WATERMARK_MAGIC = b"MC"
PROTECTED_WATERMARK_KEYS: list[bytes] = []
GAMMA_AMPLITUDE = 0.006
FIXED_QP = 22
LSB_REDUNDANCY = 5
TEMPORAL_ROTATION_STEP = 7


def _app_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


APP_ROOT = _app_root()
BIN_DIRECTORY = APP_ROOT / "lib" / "bin"
if not BIN_DIRECTORY.exists():
    BIN_DIRECTORY = APP_ROOT / "bin"
FFMPEG_PATH = BIN_DIRECTORY / "monkey_cut.exe"
FFPROBE_PATH = BIN_DIRECTORY / "monkey_info.exe"
WATERMARK_KEY_PATH = APP_ROOT / "watermark.key"

MP4_CONTAINER_ATOMS = {
    b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts", b"udta",
    b"meta", b"ilst", b"dinf", b"mvex", b"moof", b"traf",
}


def _iter_mp4_atoms(data, start: int, end: int):
    position = start
    while position + 8 <= end:
        size = int.from_bytes(data[position : position + 4], "big")
        atom_type = bytes(data[position + 4 : position + 8])
        header_size = 8
        if size == 1:
            if position + 16 > end:
                return
            size = int.from_bytes(data[position + 8 : position + 16], "big")
            header_size = 16
        elif size == 0:
            size = end - position
        if size < header_size or position + size > end:
            return
        atom_end = position + size
        yield position, atom_end, atom_type, header_size
        if atom_type in MP4_CONTAINER_ATOMS:
            child_start = position + header_size + (4 if atom_type == b"meta" else 0)
            yield from _iter_mp4_atoms(data, child_start, atom_end)
        position = atom_end


def _scrub_mp4_technical_tags(path: Path) -> tuple[int, int]:
    handler_count = 0
    encoder_count = 0
    with path.open("r+b") as handle:
        with mmap.mmap(handle.fileno(), 0) as data:
            atoms = list(_iter_mp4_atoms(data, 0, len(data)))
            for start, end, atom_type, header_size in atoms:
                if atom_type == b"hdlr":
                    name_start = start + header_size + 24
                    if name_start < end:
                        data[name_start:end] = b"\0" * (end - name_start)
                        handler_count += 1
                elif atom_type == b"\xa9too":
                    data[start + 4 : start + 8] = b"free"
                    payload_start = start + header_size
                    data[payload_start:end] = b"\0" * (end - payload_start)
                    encoder_count += 1
            data.flush()
    return handler_count, encoder_count


def set_stop_flag(flag: bool) -> None:
    global STOP_FLAG
    STOP_FLAG = bool(flag)


def get_best_thread_count() -> int:
    # Each x264 process already uses all CPU cores. Running multiple jobs in
    # parallel increases contention and makes stop/progress handling unstable.
    return 1


def extract_index_from_filename(filename: str) -> int:
    stem = Path(filename).stem
    parenthesized = re.findall(r"\((\d+)\)", stem)
    if parenthesized:
        return int(parenthesized[-1])
    numbers = re.findall(r"\d+", stem)
    if numbers:
        return int(numbers[-1])
    return zlib.crc32(stem.encode("utf-8")) % 10000


def get_existing_indices(output_dir: str, product_name: str, today_time: str, short_md5: str) -> set[int]:
    del product_name, today_time, short_md5
    result: set[int] = set()
    path = Path(output_dir)
    if not path.exists():
        return result
    for item in path.glob("*.mp4"):
        match = re.search(r"-([0-9]+)\.mp4$", item.name)
        if match:
            result.add(int(match.group(1)))
    return result


def _load_or_create_key() -> bytes:
    if WATERMARK_KEY_PATH.exists():
        value = WATERMARK_KEY_PATH.read_text(encoding="ascii").strip()
        return bytes.fromhex(value)
    key = os.urandom(32)
    WATERMARK_KEY_PATH.write_text(key.hex(), encoding="ascii")
    return key


def _hamming74_encode_nibble(value: int) -> list[int]:
    d1 = (value >> 3) & 1
    d2 = (value >> 2) & 1
    d3 = (value >> 1) & 1
    d4 = value & 1
    p1 = d1 ^ d2 ^ d4
    p2 = d1 ^ d3 ^ d4
    p4 = d2 ^ d3 ^ d4
    return [p1, p2, d1, p4, d2, d3, d4]


def _hamming74_decode(bits: list[int]) -> tuple[int, bool]:
    if len(bits) != 7:
        raise ValueError("Hamming(7,4) requires seven bits")
    values = [0] + [int(bit) & 1 for bit in bits]
    syndrome = (
        (values[1] ^ values[3] ^ values[5] ^ values[7])
        + 2 * (values[2] ^ values[3] ^ values[6] ^ values[7])
        + 4 * (values[4] ^ values[5] ^ values[6] ^ values[7])
    )
    corrected = syndrome != 0
    if 1 <= syndrome <= 7:
        values[syndrome] ^= 1
    value = (values[3] << 3) | (values[5] << 2) | (values[6] << 1) | values[7]
    return value, corrected


def _watermark_bits(input_path: Path) -> list[int]:
    name_crc = binascii.crc_hqx(input_path.name.encode("utf-8"), 0xFFFF)
    payload = WATERMARK_MAGIC + name_crc.to_bytes(2, "big")
    bits: list[int] = []
    for byte in payload:
        bits.extend(_hamming74_encode_nibble(byte >> 4))
        bits.extend(_hamming74_encode_nibble(byte & 0x0F))
    return bits


def _haar_dwt(block: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    a = block[0::2, 0::2]
    b = block[0::2, 1::2]
    c = block[1::2, 0::2]
    d = block[1::2, 1::2]
    ll = (a + b + c + d) * 0.5
    lh = (a - b + c - d) * 0.5
    hl = (a + b - c - d) * 0.5
    hh = (a - b - c + d) * 0.5
    return ll, lh, hl, hh


def _haar_idwt(ll: np.ndarray, lh: np.ndarray, hl: np.ndarray, hh: np.ndarray) -> np.ndarray:
    output = np.empty((ll.shape[0] * 2, ll.shape[1] * 2), dtype=np.float32)
    output[0::2, 0::2] = (ll + lh + hl + hh) * 0.5
    output[0::2, 1::2] = (ll - lh + hl - hh) * 0.5
    output[1::2, 0::2] = (ll + lh - hl - hh) * 0.5
    output[1::2, 1::2] = (ll - lh - hl + hh) * 0.5
    return output


def _qim_value(value: float, bit: int, step: float) -> float:
    period = 2.0 * step
    return round((value - bit * step) / period) * period + bit * step


def _ordered_block_positions(width: int, height: int, key: bytes, frame_index: int) -> list[tuple[int, int]]:
    size = WATERMARK_BLOCK_SIZE
    margin = size
    positions = [
        (x, y)
        for y in range(margin, height - margin - size + 1, size)
        for x in range(margin, width - margin - size + 1, size)
    ]
    seed_bytes = hashlib.sha256(key + frame_index.to_bytes(8, "big")).digest()
    rng = random.Random(int.from_bytes(seed_bytes[:8], "big"))
    rng.shuffle(positions)
    return positions


def _block_positions(width: int, height: int, count: int, key: bytes, frame_index: int) -> list[tuple[int, int]]:
    positions = _ordered_block_positions(width, height, key, frame_index)
    protected = set()
    for protected_key in PROTECTED_WATERMARK_KEYS:
        if protected_key != key:
            protected.update(
                _ordered_block_positions(width, height, protected_key, frame_index)[:count]
            )
    positions = [position for position in positions if position not in protected]
    if len(positions) < count:
        raise ValueError("Video frame is too small for the configured watermark payload")
    return positions[:count]


def _embed_frequency_watermark(y_plane: np.ndarray, bits: list[int], key: bytes, frame_index: int) -> None:
    positions = _block_positions(y_plane.shape[1], y_plane.shape[0], len(bits), key, frame_index)
    size = WATERMARK_BLOCK_SIZE
    for bit, (x, y) in zip(bits, positions):
        block = y_plane[y : y + size, x : x + size].astype(np.float32)
        ll, lh, hl, hh = _haar_dwt(block)
        u, singular_values, vt = np.linalg.svd(ll, full_matrices=False)
        singular_values[1] = _qim_value(float(singular_values[1]), bit, WATERMARK_QIM_STEP)
        modified_ll = (u * singular_values) @ vt
        reconstructed = _haar_idwt(modified_ll, lh, hl, hh)
        y_plane[y : y + size, x : x + size] = np.clip(np.rint(reconstructed), 0, 255).astype(np.uint8)


def _temporal_bits(bits: list[int], frame_index: int) -> list[int]:
    if not bits:
        return []
    epoch = frame_index // max(1, WATERMARK_INTERVAL)
    offset = (epoch * TEMPORAL_ROTATION_STEP) % len(bits)
    return bits[offset:] + bits[:offset]


def _lsb_positions(width: int, height: int, count: int, key: bytes, frame_index: int) -> list[tuple[int, int]]:
    margin = 16
    if width <= margin * 2 or height <= margin * 2:
        raise ValueError("Video frame is too small for the configured LSB watermark payload")
    seed = hashlib.sha256(key + b"LSB" + frame_index.to_bytes(8, "big")).digest()
    rng = random.Random(int.from_bytes(seed[:8], "big"))
    positions: set[tuple[int, int]] = set()
    while len(positions) < count:
        positions.add((rng.randrange(margin, width - margin), rng.randrange(margin, height - margin)))
    return list(positions)


def _embed_lsb_temporal_watermark(y_plane: np.ndarray, bits: list[int], key: bytes, frame_index: int) -> None:
    temporal_bits = _temporal_bits(bits, frame_index)
    positions = _lsb_positions(
        y_plane.shape[1],
        y_plane.shape[0],
        len(temporal_bits) * LSB_REDUNDANCY,
        key,
        frame_index,
    )
    for bit_index, bit in enumerate(temporal_bits):
        for repeat_index in range(LSB_REDUNDANCY):
            x, y = positions[bit_index * LSB_REDUNDANCY + repeat_index]
            y_plane[y, x] = (int(y_plane[y, x]) & 0xFE) | bit


def _embed_watermark(y_plane: np.ndarray, bits: list[int], key: bytes, frame_index: int) -> None:
    _embed_frequency_watermark(y_plane, bits, key, frame_index)
    _embed_lsb_temporal_watermark(y_plane, bits, key, frame_index)


def extract_watermark_payload(y_plane: np.ndarray, key: bytes, frame_index: int) -> tuple[bytes, int]:
    bit_count = 56
    positions = _block_positions(y_plane.shape[1], y_plane.shape[0], bit_count, key, frame_index)
    bits: list[int] = []
    size = WATERMARK_BLOCK_SIZE
    for x, y in positions:
        block = y_plane[y : y + size, x : x + size].astype(np.float32)
        ll, _lh, _hl, _hh = _haar_dwt(block)
        singular_values = np.linalg.svd(ll, compute_uv=False)
        bits.append(int(round(float(singular_values[1]) / WATERMARK_QIM_STEP)) & 1)

    nibbles = []
    corrected_errors = 0
    for offset in range(0, len(bits), 7):
        value, corrected = _hamming74_decode(bits[offset : offset + 7])
        nibbles.append(value)
        corrected_errors += int(corrected)
    payload = bytes((nibbles[index] << 4) | nibbles[index + 1] for index in range(0, len(nibbles), 2))
    return payload, corrected_errors


def _apply_gamma(y_plane: np.ndarray, frame_index: int) -> None:
    gamma = 1.0 + GAMMA_AMPLITUDE * math.sin(2.0 * math.pi * frame_index / 47.0)
    normalized = y_plane.astype(np.float32) / 255.0
    corrected = np.power(normalized, 1.0 / gamma) * 255.0
    y_plane[:] = np.clip(np.rint(corrected), 0, 255).astype(np.uint8)


def _probe_video(input_path: Path) -> dict:
    command = [
        str(FFPROBE_PATH),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height,avg_frame_rate,nb_frames,duration",
        "-of",
        "json",
        str(input_path),
    ]
    result = subprocess.run(command, check=True, capture_output=True, text=True, encoding="utf-8")
    stream = json.loads(result.stdout)["streams"][0]
    numerator, denominator = (int(part) for part in stream["avg_frame_rate"].split("/"))
    fps = numerator / denominator if denominator else 30.0
    frame_count = int(stream.get("nb_frames") or 0)
    if frame_count <= 0:
        frame_count = max(1, round(float(stream.get("duration") or 0) * fps))
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": fps,
        "frame_count": frame_count,
        "duration": float(stream.get("duration") or 0),
    }


def _read_exact(stream, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining:
        chunk = stream.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _drain_stderr(stream, sink: list[str]) -> None:
    for line in iter(stream.readline, b""):
        sink.append(line.decode("utf-8", errors="replace").rstrip())
        if len(sink) > 200:
            del sink[:50]


def _stop_process(process: subprocess.Popen | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.kill()
    process.wait(timeout=5)


def _process_one_pass(
    input_path: Path,
    output_path: Path,
    progress_callback=None,
    target_width: int = 1080,
    target_height: int = 1920,
    target_fps: float = 30.0,
    fixed_qp: int = FIXED_QP,
) -> tuple[bool, str]:
    info = _probe_video(input_path)
    width = int(target_width)
    height = int(target_height)
    fps = float(target_fps)
    frame_count = max(1, round(float(info["duration"]) * fps))
    y_size = width * height
    frame_size = y_size + 2 * ((width // 2) * (height // 2))
    key = _load_or_create_key()
    bits = _watermark_bits(input_path)
    partial_path = output_path.with_suffix(".part.mp4")
    video_only_path = output_path.with_suffix(".video.mp4")
    partial_path.unlink(missing_ok=True)
    video_only_path.unlink(missing_ok=True)

    decoder_command = [
        str(FFMPEG_PATH),
        "-v",
        "error",
        "-i",
        str(input_path),
        "-map",
        "0:v:0",
        "-vf",
        (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,"
            f"fps={fps:.8f},format=yuv420p"
        ),
        "-pix_fmt",
        "yuv420p",
        "-f",
        "rawvideo",
        "pipe:1",
    ]
    encoder_command = [
        str(FFMPEG_PATH),
        "-v",
        "error",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "yuv420p",
        "-s:v",
        f"{width}x{height}",
        "-r",
        f"{fps:.8f}",
        "-i",
        "pipe:0",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-tune",
        "film",
        "-profile:v",
        "main",
        "-qp",
        str(fixed_qp),
        "-g",
        "60",
        "-keyint_min",
        "30",
        "-bf",
        "2",
        "-x264-params",
        "aq-mode=0:scenecut=40",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-y",
        str(video_only_path),
    ]

    decoder = None
    encoder = None
    decoder_errors: list[str] = []
    encoder_errors: list[str] = []
    try:
        decoder = subprocess.Popen(decoder_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        encoder = subprocess.Popen(encoder_command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
        threading.Thread(target=_drain_stderr, args=(decoder.stderr, decoder_errors), daemon=True).start()
        threading.Thread(target=_drain_stderr, args=(encoder.stderr, encoder_errors), daemon=True).start()
        assert decoder.stdout is not None
        assert encoder.stdin is not None

        frame_index = 0
        while True:
            if STOP_FLAG:
                raise InterruptedError("任务已手动停止")
            raw = _read_exact(decoder.stdout, frame_size)
            if not raw:
                break
            if len(raw) != frame_size:
                raise RuntimeError(f"解码帧不完整: {len(raw)}/{frame_size}")

            frame = np.frombuffer(raw, dtype=np.uint8).copy()
            y_plane = frame[:y_size].reshape(height, width)
            _apply_gamma(y_plane, frame_index)
            if frame_index % WATERMARK_INTERVAL == 0:
                _embed_watermark(y_plane, bits, key, frame_index)
            encoder.stdin.write(frame.tobytes())

            frame_index += 1
            if progress_callback and (frame_index % 10 == 0 or frame_index == frame_count):
                progress = min(99.0, frame_index * 100.0 / max(frame_count, 1))
                status = VIDEO_PROCESS_STATUS["WATERMARK"] if frame_index % WATERMARK_INTERVAL == 0 else VIDEO_PROCESS_STATUS["ENCODE"]
                progress_callback(progress, status)

        encoder.stdin.close()
        decoder_code = decoder.wait()
        encoder_code = encoder.wait()
        if decoder_code != 0:
            raise RuntimeError("解码失败: " + "\n".join(decoder_errors[-20:]))
        if encoder_code != 0:
            raise RuntimeError("编码失败: " + "\n".join(encoder_errors[-20:]))
        if not video_only_path.exists() or video_only_path.stat().st_size == 0:
            raise RuntimeError("编码未生成有效输出文件")

        remux_command = [
            str(FFMPEG_PATH),
            "-v",
            "error",
            "-i",
            str(video_only_path),
            "-i",
            str(input_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a?",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
            "-disposition:v:0",
            "0",
            "-metadata",
            "title=",
            "-metadata",
            "artist=",
            "-metadata",
            "album=",
            "-metadata",
            "genre=",
            "-metadata",
            "date=",
            "-metadata",
            "description=",
            "-metadata",
            "comment=",
            "-metadata",
            "copyright=",
            "-metadata",
            "location=",
            "-metadata",
            "make=",
            "-metadata",
            "model=",
            "-metadata",
            "software=",
            "-metadata",
            "creation_time=",
            "-metadata",
            "encoder=",
            "-metadata:s:v:0",
            "title=",
            "-metadata:s:v:0",
            "comment=",
            "-metadata:s:v:0",
            "creation_time=",
            "-metadata:s:v:0",
            "handler_name=",
            "-metadata:s:v:0",
            "vendor_id=",
            "-metadata:s:v:0",
            "language=",
            "-metadata:s:a:0",
            "title=",
            "-metadata:s:a:0",
            "comment=",
            "-metadata:s:a:0",
            "creation_time=",
            "-metadata:s:a:0",
            "handler_name=",
            "-metadata:s:a:0",
            "vendor_id=",
            "-metadata:s:a:0",
            "language=",
            "-c:v",
            "copy",
            "-bsf:v",
            "filter_units=remove_types=6",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-movflags",
            "+faststart",
            "-brand",
            "isom",
            "-video_track_timescale",
            str(int(round(fps))),
            "-y",
            str(partial_path),
        ]
        remux = subprocess.run(remux_command, capture_output=True, text=True, encoding="utf-8")
        if remux.returncode != 0:
            raise RuntimeError("音视频封装失败: " + remux.stderr[-2000:])

        _scrub_mp4_technical_tags(partial_path)

        os.replace(partial_path, output_path)
        video_only_path.unlink(missing_ok=True)
        if progress_callback:
            progress_callback(100, VIDEO_PROCESS_STATUS["DONE"])
        return True, f"深度元数据/SEI/技术标签清理 + 频域 DWT/SVD/QIM/ECC + LSB + 时序混合水印 + x264 QP {fixed_qp} 完成"
    except Exception as exc:
        _stop_process(decoder)
        _stop_process(encoder)
        partial_path.unlink(missing_ok=True)
        video_only_path.unlink(missing_ok=True)
        return False, str(exc)


def process_video_with_ffmpeg(
    filename: str,
    directory: str,
    output_dir: str,
    today_time: str,
    product_name: str,
    short_md5: str,
    existing_indices: set[int],
    progress_callback=None,
):
    del product_name, short_md5
    if STOP_FLAG:
        return filename, False, "任务已手动停止"

    input_path = Path(directory) / filename
    output_path = Path(output_dir) / f"{input_path.stem}_AI_{today_time}.mp4"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    index = extract_index_from_filename(filename)
    logger.info("单次处理开始: %s", filename)
    success, message = _process_one_pass(input_path, output_path, progress_callback)
    if success:
        existing_indices.add(index)
        logger.info("处理完成: %s -> %s", filename, output_path.name)
        return filename, True, output_path.name
    logger.error("处理失败: %s: %s", filename, message)
    return filename, False, message


def main() -> None:
    global FFMPEG_PATH, FFPROBE_PATH, WATERMARK_KEY_PATH
    global WATERMARK_QIM_STEP, WATERMARK_MAGIC, PROTECTED_WATERMARK_KEYS
    global GAMMA_AMPLITUDE, WATERMARK_INTERVAL, LSB_REDUNDANCY, TEMPORAL_ROTATION_STEP
    parser = argparse.ArgumentParser(description="Metadata cleanup with DWT/SVD/QIM watermarking")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--ffprobe", type=Path, required=True)
    parser.add_argument("--key", type=Path, required=True)
    parser.add_argument("--payload-tag", default="MC")
    parser.add_argument("--protect-key", type=Path, action="append", default=[])
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--qp", type=int, default=FIXED_QP)
    parser.add_argument("--qim-step", type=float, default=WATERMARK_QIM_STEP)
    parser.add_argument("--gamma-amplitude", type=float, default=GAMMA_AMPLITUDE)
    parser.add_argument("--interval-frames", type=int, default=WATERMARK_INTERVAL)
    parser.add_argument("--lsb-redundancy", type=int, default=LSB_REDUNDANCY)
    parser.add_argument("--temporal-rotation-step", type=int, default=TEMPORAL_ROTATION_STEP)
    args = parser.parse_args()

    FFMPEG_PATH = args.ffmpeg.resolve()
    FFPROBE_PATH = args.ffprobe.resolve()
    WATERMARK_KEY_PATH = args.key.resolve()
    payload_tag = args.payload_tag.encode("ascii", errors="strict")
    if len(payload_tag) != 2:
        parser.error("--payload-tag must contain exactly two ASCII bytes")
    WATERMARK_MAGIC = payload_tag
    PROTECTED_WATERMARK_KEYS = [
        bytes.fromhex(path.read_text(encoding="ascii").strip())
        for path in args.protect_key
    ]
    WATERMARK_QIM_STEP = float(args.qim_step)
    GAMMA_AMPLITUDE = float(args.gamma_amplitude)
    WATERMARK_INTERVAL = int(args.interval_frames)
    LSB_REDUNDANCY = max(1, int(args.lsb_redundancy))
    TEMPORAL_ROTATION_STEP = max(1, int(args.temporal_rotation_step))
    args.output.parent.mkdir(parents=True, exist_ok=True)

    def report_progress(progress: float, status: str) -> None:
        print(f"PROGRESS|{progress:.2f}|{status}", flush=True)

    success, message = _process_one_pass(
        args.input.resolve(),
        args.output.resolve(),
        report_progress,
        target_width=args.width,
        target_height=args.height,
        target_fps=args.fps,
        fixed_qp=args.qp,
    )
    print(json.dumps({"success": success, "message": message}, ensure_ascii=False), flush=True)
    raise SystemExit(0 if success else 1)


if __name__ == "__main__":
    main()
