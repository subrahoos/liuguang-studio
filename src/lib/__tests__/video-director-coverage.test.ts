import { describe, expect, it } from "vitest";
import {
  assertDirectorCoverageMarkers,
  buildDirectorEvidenceCoverage,
  buildDirectorSegmentEditorialTimingLocks,
  DIRECTOR_EVIDENCE_DOMAINS,
  validateAndStripDirectorCoverageMarkers,
} from "@/lib/video-director-coverage";
import { splitTargetDurationIntoVideoSegments } from "@/lib/video-shot-segments";

describe("video director evidence coverage", () => {
  const analysis = {
    timeline: [
      { timeRange: "00:00:00.000-00:00:04.000" },
      { timeRange: "00:00:04.000-00:00:12.000" },
    ],
  };

  it("binds every overlapping shot domain to each segment", () => {
    const coverage = buildDirectorEvidenceCoverage(
      analysis,
      splitTargetDurationIntoVideoSegments(12, 10),
    );
    expect(coverage).toHaveLength(2);
    expect(coverage[0].evidenceIds).toHaveLength(DIRECTOR_EVIDENCE_DOMAINS.length * 2);
    expect(coverage[1].evidenceIds).toHaveLength(DIRECTOR_EVIDENCE_DOMAINS.length);
    expect(coverage[0].manifestLines[0]).toContain("SHOT_01_FRAMING");
    expect(coverage[1].evidenceIds).toContain("SHOT_02_END_STATE");
    expect(coverage[0].assignments).toContainEqual({
      evidenceId: "SHOT_01_BOUNDARY",
      heading: "TRANSITION INTENT",
    });
  });

  it("builds a server-owned local timing lock from exact reference shot boundaries", () => {
    const locks = buildDirectorSegmentEditorialTimingLocks({
      timeline: [
        { timeRange: "00:00:00.000-00:00:03.533" },
        { timeRange: "00:00:03.533-00:00:09.100" },
        { timeRange: "00:00:09.100-00:00:15.100" },
      ],
    }, splitTargetDurationIntoVideoSegments(16, 10));

    expect(locks[0].text).toContain("0.000-3.533s=S1");
    expect(locks[0].text).toContain("3.533-9.100s=S2");
    expect(locks[0].text).toContain("9.100-10.000s=S3");
    expect(locks[0].text).toContain("cuts 3.533, 9.100");
    expect(locks[1].text).toContain("0.000-10.000s=S3");
    expect(locks[1].text).toContain("cuts none");
  });

  it("keeps a later independent task at the next hard-cut entry instead of splitting a shot", () => {
    const locks = buildDirectorSegmentEditorialTimingLocks({
      timeline: [
        { timeRange: "00:00:00.000-00:00:03.533" },
        { timeRange: "00:00:03.533-00:00:09.100" },
        { timeRange: "00:00:09.100-00:00:15.100" },
      ],
    }, splitTargetDurationIntoVideoSegments(16, 10, [3.533, 9.1]));

    expect(locks[0].text).toContain("0.000-3.533s=S1");
    expect(locks[0].text).toContain("3.533-10.000s=S2");
    expect(locks[0].text).toContain("cuts 3.533");
    expect(locks[0].text).not.toContain("S3");
    expect(locks[1].text).toContain("0.000-10.000s=S3");
  });

  it("requires every model-declared coverage marker to introduce its assigned executable fact, then strips it", () => {
    const expected = buildDirectorEvidenceCoverage(
      { timeline: [{ timeRange: "00:00:00.000-00:00:10.000" }] },
      splitTargetDurationIntoVideoSegments(10, 10),
    )[0];
    const grouped = new Map<string, string[]>();
    expected.assignments.forEach(({ evidenceId, heading }) => {
      const lines = grouped.get(heading) || [];
      lines.push(`[${evidenceId}] Preserve this concrete evidenced execution fact.`);
      grouped.set(heading, lines);
    });
    const prompt = Array.from(grouped, ([heading, lines]) => `${heading}:\n${lines.join("\n")}`).join("\n");
    expect(() => assertDirectorCoverageMarkers(prompt, expected)).not.toThrow();
    const storedPrompt = validateAndStripDirectorCoverageMarkers(prompt, expected);
    expect(storedPrompt).not.toContain("[SHOT_");
    expect(storedPrompt).toContain("Preserve this concrete evidenced execution fact.");
    expect(() => assertDirectorCoverageMarkers(
      prompt.replace("[SHOT_01_FRAMING]", ""),
      expected,
    )).toThrow(/SHOT_01_FRAMING/);
    expect(() => assertDirectorCoverageMarkers(
      prompt.replace(
        "[SHOT_01_PERFORMANCE] Preserve this concrete evidenced execution fact.",
        "[SHOT_01_PERFORMANCE]",
      ),
      expected,
    )).toThrow(/SHOT_01_PERFORMANCE.*完整/);
    expect(() => assertDirectorCoverageMarkers(
      prompt.replace("[SHOT_01_FRAMING]", "[SHOT_01_UNKNOWN]"),
      expected,
    )).toThrow(/未知/);
  });
});
