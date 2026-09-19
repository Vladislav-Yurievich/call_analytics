from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import site
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CALL_RE = re.compile(
    r"^(?P<source>\d+)_(?P<direction>in|out)_(?P<target>\d+)_"
    r"(?P<date>\d{4}_\d{2}_\d{2})-(?P<time>\d{2}_\d{2}_\d{2})_"
    r"(?P<call_id>[^.]+)\.mp3$",
    re.IGNORECASE,
)


@dataclass
class RuntimeConfig:
    model: str
    device: str
    compute_type: str
    forced_language: str | None
    beam_size: int
    best_of: int
    vad_filter: bool
    multilingual: bool
    condition_on_previous_text: bool
    word_timestamps: bool
    language_detection_segments: int
    hotwords: str | None


def add_windows_cuda_dll_dirs() -> list[str]:
    """Make CUDA runtime DLLs installed by pip visible to CTranslate2 on Windows."""
    added: list[str] = []
    if os.name != "nt":
        return added

    for base in site.getsitepackages():
        nvidia = Path(base) / "nvidia"
        for rel in ("cublas/bin", "cudnn/bin", "cuda_nvrtc/bin"):
            dll_dir = nvidia / rel
            if dll_dir.exists():
                try:
                    os.add_dll_directory(str(dll_dir))
                except (FileNotFoundError, OSError):
                    pass
                os.environ["PATH"] = str(dll_dir) + os.pathsep + os.environ.get("PATH", "")
                added.append(str(dll_dir))
    return added


def parse_call_filename(path: Path) -> dict[str, Any]:
    match = CALL_RE.match(path.name)
    if not match:
        return {
            "source_number": None,
            "target_number": None,
            "direction": None,
            "call_datetime": None,
            "call_id": path.stem,
        }

    data = match.groupdict()
    call_dt = None
    try:
        call_dt = datetime.strptime(
            f"{data['date']} {data['time']}", "%Y_%m_%d %H_%M_%S"
        ).isoformat(sep=" ")
    except ValueError:
        pass

    return {
        "source_number": data["source"],
        "target_number": data["target"],
        "direction": data["direction"].lower(),
        "call_datetime": call_dt,
        "call_id": data["call_id"],
    }


def format_ts(seconds: float | None) -> str:
    if seconds is None:
        return "--:--.---"
    millis = int(round(seconds * 1000))
    ms = millis % 1000
    total = millis // 1000
    s = total % 60
    m = (total // 60) % 60
    h = total // 3600
    if h:
        return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"
    return f"{m:02d}:{s:02d}.{ms:03d}"


def segment_to_dict(segment: Any) -> dict[str, Any]:
    words = None
    if getattr(segment, "words", None):
        words = [
            {
                "start": getattr(word, "start", None),
                "end": getattr(word, "end", None),
                "word": getattr(word, "word", ""),
                "probability": getattr(word, "probability", None),
            }
            for word in segment.words
        ]

    return {
        "id": getattr(segment, "id", None),
        "seek": getattr(segment, "seek", None),
        "start": getattr(segment, "start", None),
        "end": getattr(segment, "end", None),
        "text": getattr(segment, "text", "").strip(),
        "avg_logprob": getattr(segment, "avg_logprob", None),
        "compression_ratio": getattr(segment, "compression_ratio", None),
        "no_speech_prob": getattr(segment, "no_speech_prob", None),
        "temperature": getattr(segment, "temperature", None),
        "words": words,
    }


def is_suspect_silence_segment(segment: dict[str, Any], audio_duration: float | None) -> bool:
    no_speech_prob = segment.get("no_speech_prob")
    start = segment.get("start")
    end = segment.get("end")
    if no_speech_prob is None or start is None or end is None:
        return False

    segment_duration = max(0.0, end - start)
    past_audio_end = audio_duration is not None and end > audio_duration + 1.0
    return no_speech_prob >= 0.75 and (segment_duration >= 8.0 or past_audio_end)


def write_txt(path: Path, result: dict[str, Any]) -> None:
    lines = [
        f"Файл: {result['file_name']}",
        f"Модель: {result['runtime']['model']}",
        f"Устройство: {result['runtime']['device']} / {result['runtime']['compute_type']}",
        f"Определенный язык: {result.get('language')} ({result.get('language_probability')})",
        f"Длительность аудио, сек: {result.get('duration_sec')}",
        f"Длительность речи после VAD, сек: {result.get('duration_after_vad_sec')}",
        "",
        "Текст:",
        result["text"],
        "",
        "Сегменты:",
    ]
    for segment in result["segments"]:
        lines.append(
            f"[{format_ts(segment['start'])} - {format_ts(segment['end'])}] {segment['text']}"
        )
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8-sig")


def build_result(
    audio_path: Path,
    runtime: RuntimeConfig,
    info: Any,
    segments: list[Any],
    elapsed_sec: float,
) -> dict[str, Any]:
    segment_dicts = [segment_to_dict(segment) for segment in segments]
    audio_duration = getattr(info, "duration", None)
    dropped_segments = [
        segment
        for segment in segment_dicts
        if is_suspect_silence_segment(segment, audio_duration)
    ]
    segment_dicts = [
        segment
        for segment in segment_dicts
        if not is_suspect_silence_segment(segment, audio_duration)
    ]
    text = " ".join(segment["text"] for segment in segment_dicts if segment["text"]).strip()
    metadata = parse_call_filename(audio_path)
    return {
        "file_name": audio_path.name,
        "file_stem": audio_path.stem,
        "audio_path": str(audio_path.resolve()),
        "audio_sha256": hashlib.sha256(audio_path.read_bytes()).hexdigest(),
        "metadata_from_filename": metadata,
        "transcribed_at_utc": datetime.now(timezone.utc).isoformat(),
        "elapsed_sec": round(elapsed_sec, 3),
        "runtime": asdict(runtime),
        "language": getattr(info, "language", None),
        "language_probability": getattr(info, "language_probability", None),
        "duration_sec": getattr(info, "duration", None),
        "duration_after_vad_sec": getattr(info, "duration_after_vad", None),
        "dropped_suspect_segments": dropped_segments,
        "text": text,
        "segments": segment_dicts,
    }


def write_manifest(output_dir: Path, results: list[dict[str, Any]]) -> None:
    jsonl_path = output_dir / "all_transcripts.jsonl"
    with jsonl_path.open("w", encoding="utf-8") as handle:
        for result in results:
            handle.write(json.dumps(result, ensure_ascii=False) + "\n")

    csv_path = output_dir / "transcription_manifest.csv"
    columns = [
        "file_name",
        "source_number",
        "target_number",
        "direction",
        "call_datetime",
        "call_id",
        "language",
        "language_probability",
        "duration_sec",
        "duration_after_vad_sec",
        "elapsed_sec",
        "dropped_suspect_segments_count",
        "text",
        "json_path",
        "txt_path",
    ]
    with csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=columns)
        writer.writeheader()
        for result in results:
            meta = result.get("metadata_from_filename", {})
            stem = result["file_stem"]
            writer.writerow(
                {
                    "file_name": result["file_name"],
                    "source_number": meta.get("source_number"),
                    "target_number": meta.get("target_number"),
                    "direction": meta.get("direction"),
                    "call_datetime": meta.get("call_datetime"),
                    "call_id": meta.get("call_id"),
                    "language": result.get("language"),
                    "language_probability": result.get("language_probability"),
                    "duration_sec": result.get("duration_sec"),
                    "duration_after_vad_sec": result.get("duration_after_vad_sec"),
                    "elapsed_sec": result.get("elapsed_sec"),
                    "dropped_suspect_segments_count": len(
                        result.get("dropped_suspect_segments") or []
                    ),
                    "text": result.get("text"),
                    "json_path": str((output_dir / "json" / f"{stem}.json").resolve()),
                    "txt_path": str((output_dir / "txt" / f"{stem}.txt").resolve()),
                }
            )


def read_existing_results(output_dir: Path) -> list[dict[str, Any]]:
    results = []
    json_dir = output_dir / "json"
    for path in sorted(json_dir.glob("*.json")):
        try:
            results.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            print(f"[warn] cannot read existing result: {path}", file=sys.stderr)
    return results


def transcribe_file(audio_path: Path, model: Any, runtime: RuntimeConfig) -> dict[str, Any]:
    started = time.time()
    segments_iter, info = model.transcribe(
        str(audio_path),
        language=runtime.forced_language,
        task="transcribe",
        beam_size=runtime.beam_size,
        best_of=runtime.best_of,
        vad_filter=runtime.vad_filter,
        multilingual=runtime.multilingual,
        condition_on_previous_text=runtime.condition_on_previous_text,
        word_timestamps=runtime.word_timestamps,
        language_detection_segments=runtime.language_detection_segments,
        hotwords=runtime.hotwords,
    )
    segments = list(segments_iter)
    return build_result(audio_path, runtime, info, segments, time.time() - started)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe MP3 calls with faster-whisper.")
    parser.add_argument("--input-dir", default="calls_mp3", type=Path)
    parser.add_argument("--output-dir", default="transcripts", type=Path)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="cuda", choices=["cuda", "cpu"])
    parser.add_argument("--compute-type", default="float16")
    parser.add_argument("--beam-size", default=5, type=int)
    parser.add_argument("--best-of", default=5, type=int)
    parser.add_argument("--language", default=None)
    parser.add_argument("--hotwords", default=None)
    parser.add_argument("--file-list", default=None, type=Path)
    parser.add_argument("--language-detection-segments", default=3, type=int)
    parser.add_argument("--limit", default=None, type=int)
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--word-timestamps", action="store_true")
    parser.add_argument("--no-vad", action="store_true")
    parser.add_argument("--no-condition-on-previous-text", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    add_windows_cuda_dll_dirs()

    from faster_whisper import WhisperModel

    input_dir = args.input_dir
    output_dir = args.output_dir
    json_dir = output_dir / "json"
    txt_dir = output_dir / "txt"
    json_dir.mkdir(parents=True, exist_ok=True)
    txt_dir.mkdir(parents=True, exist_ok=True)

    audio_files = sorted(input_dir.glob("*.mp3"))
    if args.file_list:
        requested = {
            line.strip()
            for line in args.file_list.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        }
        audio_files = [
            path
            for path in audio_files
            if path.name in requested or str(path) in requested or str(path.resolve()) in requested
        ]
    if args.limit:
        audio_files = audio_files[: args.limit]
    if not audio_files:
        print(f"No MP3 files found in {input_dir}")
        return 1

    runtime = RuntimeConfig(
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        forced_language=args.language,
        beam_size=args.beam_size,
        best_of=args.best_of,
        vad_filter=not args.no_vad,
        multilingual=args.language is None,
        condition_on_previous_text=not args.no_condition_on_previous_text,
        word_timestamps=args.word_timestamps,
        language_detection_segments=args.language_detection_segments,
        hotwords=args.hotwords,
    )

    print(
        "Loading model "
        f"{runtime.model} on {runtime.device} with compute_type={runtime.compute_type}..."
    )
    model = WhisperModel(runtime.model, device=runtime.device, compute_type=runtime.compute_type)

    total = len(audio_files)
    completed = 0
    for index, audio_path in enumerate(audio_files, start=1):
        json_path = json_dir / f"{audio_path.stem}.json"
        txt_path = txt_dir / f"{audio_path.stem}.txt"
        if json_path.exists() and not args.overwrite:
            try:
                saved = json.loads(json_path.read_text(encoding="utf-8"))
                valid = (isinstance(saved, dict) and saved.get("file_name") == audio_path.name
                         and isinstance(saved.get("text"), str) and isinstance(saved.get("segments"), list)
                         and isinstance(saved.get("duration_sec"), (int, float)))
                if valid and saved.get("audio_sha256"):
                    valid = saved["audio_sha256"] == hashlib.sha256(audio_path.read_bytes()).hexdigest()
            except (OSError, ValueError):
                valid = False
            if valid:
                completed += 1
                print(f"[{index}/{total}] skip existing {audio_path.name}", flush=True)
                continue

        print(f"[{index}/{total}] transcribing {audio_path.name}", flush=True)
        try:
            result = transcribe_file(audio_path, model, runtime)
            temporary_path = json_path.with_suffix(".json.tmp")
            temporary_path.write_text(
                json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            temporary_path.replace(json_path)
            write_txt(txt_path, result)
            completed += 1
            print(
                "    done "
                f"elapsed={result['elapsed_sec']}s "
                f"duration={result.get('duration_sec')}s "
                f"lang={result.get('language')} "
                f"chars={len(result.get('text') or '')}",
                flush=True,
            )
        except Exception as exc:
            error_path = output_dir / "errors.log"
            with error_path.open("a", encoding="utf-8") as handle:
                handle.write(f"{datetime.now().isoformat()} {audio_path.name}: {exc!r}\n")
            print(f"    ERROR {audio_path.name}: {exc!r}", file=sys.stderr, flush=True)

    results = read_existing_results(output_dir)
    write_manifest(output_dir, results)
    print(f"Completed {completed}/{total}. Manifest: {output_dir / 'transcription_manifest.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
