import argparse
import json
import sys
from pathlib import Path


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="strict")


def format_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{millis:03d}"


def collect_segments(model, input_path: Path, task: str, language: str | None):
    segments, info = model.transcribe(
        str(input_path),
        task=task,
        language=language,
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
    )
    output_segments = []
    for segment in segments:
        text = " ".join(str(segment.text or "").split()).strip()
        if not text:
            continue
        output_segments.append({
            "startTime": format_timestamp(segment.start),
            "endTime": format_timestamp(segment.end),
            "text": text,
        })
    return output_segments, info


def render_text(segments):
    return "\n".join(
        f"[{segment['startTime']}-{segment['endTime']}] {segment['text']}"
        for segment in segments
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Local Mandarin transcription with faster-whisper")
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="zh")
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    if not input_path.is_file():
        raise FileNotFoundError(f"Audio file not found: {input_path}")

    from faster_whisper import WhisperModel

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    source_segments, source_info = collect_segments(model, input_path, "transcribe", args.language or None)
    if not source_segments:
        raise RuntimeError("Local transcription returned no usable speech segments")
    source_text = render_text(source_segments)
    json.dump(
        {
            "language": str(getattr(source_info, "language", "") or ""),
            "languageProbability": float(getattr(source_info, "language_probability", 0) or 0),
            "sourceSegments": source_segments,
            "sourceText": source_text,
            "segments": source_segments,
            "text": source_text,
            "targetLanguage": "zh",
            "task": "transcribe",
            "sourceTask": "transcribe",
            "model": args.model,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
