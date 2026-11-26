"""반복 집계의 GC 전후 힙·전체 RSS와 Worker 수별 RAM 관측을 그린다."""

import json
import sys
from pathlib import Path
from statistics import median

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main():
    report_path = Path(sys.argv[1])
    report = json.loads(report_path.read_text(encoding="utf-8"))
    # [표본 선택 정책] 실제 로그를 전부 재파싱한 메모리 표본만 사용한다.
    rows = [
        event
        for event in report["events"]
        if event["type"] == "sample"
        and event["dataset"] == "real"
        and event["scenario"] == "reparse"
    ]
    iterations = [row["iteration"] for row in rows]
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.3), layout="constrained")
    for axis in axes:
        axis.grid(axis="y", color="#e5e7eb", linewidth=0.7)
        axis.set_axisbelow(True)
        axis.spines[["top", "right"]].set_visible(False)
        axis.set_xlabel("Full reparse number (same input)")
        axis.set_ylabel("Memory (MB, 1 MB = 1,000,000 bytes)")
        axis.set_xlim(0.5, 20.5)
        axis.set_xticks([1, 5, 10, 15, 20])
    # [시각화 정책] GC 전후 힙과 프로세스 RSS를 두 패널에서 같은 반복 축으로 비교한다.
    axes[0].plot(iterations, [row["beforeGc"]["heapUsed"] / 1e6 for row in rows],
                 color="#d97706", marker="o", markersize=3, label="JS heap before forced GC")
    axes[0].plot(iterations, [row["afterGc"]["heapUsed"] / 1e6 for row in rows],
                 color="#2563eb", marker="o", markersize=3, label="JS heap after forced GC")
    axes[0].set_title("JavaScript objects: temporary allocation is reclaimed")
    axes[0].set_ylim(0, max(row["beforeGc"]["heapUsed"] / 1e6 for row in rows) * 1.15)
    axes[0].legend(frameon=False, fontsize=8, loc="center right")
    axes[1].plot(iterations, [row["observedPeak"]["rss"] / 1e6 for row in rows],
                 color="#9333ea", marker="o", markersize=3, label="Highest RSS sampled during work")
    axes[1].plot(iterations, [row["afterGc"]["rss"] / 1e6 for row in rows],
                 color="#0f766e", marker="o", markersize=3, label="Process RSS after forced GC")
    axes[1].set_title("Whole-process RAM: heap is only one part")
    axes[1].set_ylim(0, max(row["observedPeak"]["rss"] / 1e6 for row in rows) * 1.15)
    axes[1].legend(frameon=False, fontsize=8, loc="center right")
    fig.suptitle("Agent Tracker — 1,410 real requests, 676 frozen log files, up to 4 parsing workers", fontsize=12)
    for suffix in ["png", "svg"]:
        fig.savefig(report_path.with_name(f"SummaryMemory-2026-11-16.{suffix}"), dpi=170)
    plt.close(fig)

    if len(sys.argv) < 3:
        return
    worker_path = Path(sys.argv[2])
    # [집계 정책] Worker 설정별로 관측 RSS와 경과 시간의 중앙값을 계산해 막대로 표시한다.
    variants = json.loads(worker_path.read_text(encoding="utf-8"))["variants"]
    labels = [str(variant["requestedWorkers"]) for variant in variants]
    rss = [median(sample["observedPeak"]["rss"] for sample in variant["samples"]) / 1e6 for variant in variants]
    times = [median(sample["elapsedMs"] for sample in variant["samples"]) / 1000 for variant in variants]
    fig, axes = plt.subplots(1, 2, figsize=(9, 3.8), layout="constrained")
    for axis, values, label in zip(axes, [rss, times], ["Median sampled peak RSS (MB)", "Median elapsed time (seconds)"]):
        bars = axis.bar(labels, values, color=["#7c3aed", "#2563eb", "#0f766e"], width=0.55)
        axis.bar_label(bars, fmt="%.1f", padding=3)
        axis.set_ylim(0, max(values) * 1.17)
        axis.set_xlabel("Configured parsing workers (1 = sequential)")
        axis.set_ylabel(label)
        axis.spines[["top", "right"]].set_visible(False)
        axis.grid(axis="y", color="#e5e7eb", linewidth=0.7)
        axis.set_axisbelow(True)
    fig.suptitle("Same frozen real logs — 3 warmups + 5 full reparses per setting", fontsize=12)
    for suffix in ["png", "svg"]:
        fig.savefig(worker_path.with_suffix(f".{suffix}"), dpi=170)
    plt.close(fig)


if __name__ == "__main__":
    main()
