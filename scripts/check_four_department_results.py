from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from analyze_calls_strict import valid_cached_result, write_manifest


def check_department(department, stage):
    source_files = sorted(Path(department["inputDir"]).glob("*.mp3"))
    directory = Path(department["transcriptsDir"] if stage == "transcripts" else department["analysisDir"])
    valid = 0
    invalid = []
    expected_stems = {file.stem for file in source_files}
    extras = [file.name for file in (directory / "json").glob("*.json") if file.stem not in expected_stems]
    for source in source_files:
        try:
            result = json.loads((directory / "json" / f"{source.stem}.json").read_text(encoding="utf-8"))
            if stage == "transcripts":
                ok = (isinstance(result, dict) and result.get("file_name") == source.name
                      and isinstance(result.get("text"), str) and isinstance(result.get("segments"), list)
                      and isinstance(result.get("duration_sec"), (float, int)))
                if ok and result.get("audio_sha256"):
                    ok = result["audio_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
            else:
                transcript = json.loads((Path(department["transcriptsDir"]) / "json" / f"{source.stem}.json").read_text(encoding="utf-8"))
                ok = valid_cached_result(result, transcript, department.get("analysisSchemaVersion"))
            if ok:
                valid += 1
            else:
                invalid.append(source.name)
        except (OSError, ValueError, TypeError):
            invalid.append(source.name)
    return {"department": department["key"], "stage": stage, "expected": department["expectedCalls"],
            "sourceCount": len(source_files), "valid": valid, "invalid": invalid, "extraJson": extras}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="workbook_build/four_departments_report_config.json")
    parser.add_argument("--department")
    parser.add_argument("--stage", choices=["transcripts", "analysis", "all"], default="all")
    parser.add_argument("--rebuild-manifests", action="store_true")
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding="utf-8-sig"))
    results = []
    for department in config["departments"]:
        if args.department and department["key"] != args.department:
            continue
        for stage in (["transcripts", "analysis"] if args.stage == "all" else [args.stage]):
            result = check_department(department, stage)
            results.append(result)
            complete = result["valid"] == result["expected"] == result["sourceCount"] and not result["extraJson"]
            if complete and args.rebuild_manifests:
                if stage == "analysis":
                    write_manifest(
                        Path(department["analysisDir"]),
                        department.get("analysisSchemaVersion", "calls-strict-2.1"),
                    )
                else:
                    from transcribe_calls import read_existing_results, write_manifest as write_transcripts
                    directory = Path(department["transcriptsDir"])
                    write_transcripts(directory, read_existing_results(directory))
    print(json.dumps(results, ensure_ascii=True))
    return 0 if results and all(row["valid"] == row["expected"] == row["sourceCount"] and not row["extraJson"] for row in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
