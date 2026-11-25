import { describe, expect, it } from "vitest";
import {
  BOARD_VIDEO_MODEL,
  matchesGeneratedVideoSegment,
  splitTargetDurationIntoVideoSegments,
} from "@/lib/video-shot-segments";
import { getBoardVideoProfile, JIMENG_BOARD_VIDEO_MODEL, LINGGANYA_SD_2_BOARD_VIDEO_MODEL } from "@/lib/board-video-protocol";
import { VIDEO_DIRECTOR_SCHEMA_VERSION } from "@/lib/video-director-contract";

describe("current board video segment plan", () => {
  it("generates one full 10-second task for an 8-second evidence target", () => {
    expect(splitTargetDurationIntoVideoSegments(8)).toEqual([
      expect.objectContaining({ index: 1, start: 0, duration: 10, sourceDuration: 8, sourceTimeRange: "00:00-00:08", outputDuration: 10, outputTimeRange: "00:00-00:10", requestedTotal: 8, plannedOutputDuration: 10 }),
    ]);
  });

  it("plans 12 seconds as two full 10-second tasks without trimming the last task", () => {
    expect(splitTargetDurationIntoVideoSegments(12)).toEqual([
      expect.objectContaining({ index: 1, duration: 10, sourceDuration: 10, outputDuration: 10, sourceTimeRange: "00:00-00:10", outputTimeRange: "00:00-00:10" }),
      expect.objectContaining({ index: 2, duration: 10, sourceDuration: 2, outputDuration: 10, sourceTimeRange: "00:10-00:12", outputTimeRange: "00:10-00:20", plannedOutputDuration: 20 }),
    ]);
  });

  it("plans 20 seconds as two complete 10-second tasks", () => {
    expect(splitTargetDurationIntoVideoSegments(20).map((segment) => segment.sourceDuration)).toEqual([10, 10]);
  });

  it("moves an independent task boundary back to the last report-owned hard cut that fits", () => {
    const segments = splitTargetDurationIntoVideoSegments(16, 10, [3.533, 9.1]);

    expect(segments).toEqual([
      expect.objectContaining({
        index: 1,
        start: 0,
        sourceStart: 0,
        sourceDuration: 9.1,
        sourceTimeRange: "00:00-00:09.1",
        outputTimeRange: "00:00-00:10",
      }),
      expect.objectContaining({
        index: 2,
        start: 10,
        sourceStart: 9.1,
        sourceDuration: 6.9,
        sourceTimeRange: "00:09.1-00:16",
        outputTimeRange: "00:10-00:20",
      }),
    ]);
  });

  it("never extends the source-action window beyond the detected effective evidence end", () => {
    const segments = splitTargetDurationIntoVideoSegments(16, 10, [3.533, 9.1], 15.1);

    expect(segments.map((segment) => segment.sourceDuration)).toEqual([9.1, 6]);
    expect(segments[1].sourceTimeRange).toBe("00:09.1-00:15.1");
  });

  it("keeps every 6-second task when 15 seconds of evidence requires three tasks", () => {
    const segments = splitTargetDurationIntoVideoSegments(15, 6);
    expect(segments.map((segment) => ({
      sourceTimeRange: segment.sourceTimeRange,
      outputTimeRange: segment.outputTimeRange,
      outputDuration: segment.outputDuration,
    }))).toEqual([
      { sourceTimeRange: "00:00-00:06", outputTimeRange: "00:00-00:06", outputDuration: 6 },
      { sourceTimeRange: "00:06-00:12", outputTimeRange: "00:06-00:12", outputDuration: 6 },
      { sourceTimeRange: "00:12-00:15", outputTimeRange: "00:12-00:18", outputDuration: 6 },
    ]);
    expect(segments[0].plannedOutputDuration).toBe(18);
  });

  it("plans 25 seconds as 10+10+10 generation and keeps all 30 seconds", () => {
    expect(splitTargetDurationIntoVideoSegments(25).map((segment) => ({
      duration: segment.duration,
      sourceDuration: segment.sourceDuration,
      outputDuration: segment.outputDuration,
    }))).toEqual([
      { duration: 10, sourceDuration: 10, outputDuration: 10 },
      { duration: 10, sourceDuration: 10, outputDuration: 10 },
      { duration: 10, sourceDuration: 5, outputDuration: 10 },
    ]);
  });

  it("plans a 25-second Jimeng target as two complete 15-second tasks", () => {
    const segments = splitTargetDurationIntoVideoSegments(25, 15);
    expect(segments.map((segment) => ({ duration: segment.duration, sourceDuration: segment.sourceDuration, outputDuration: segment.outputDuration }))).toEqual([
      { duration: 15, sourceDuration: 15, outputDuration: 15 },
      { duration: 15, sourceDuration: 10, outputDuration: 15 },
    ]);
    expect(JIMENG_BOARD_VIDEO_MODEL).toBe("video-ds-2.0");
  });

  it("plans a Lingganya sd-2.0 target as 15-second 1080p tasks", () => {
    const segments = splitTargetDurationIntoVideoSegments(21, 15);
    expect(segments.map((segment) => ({ duration: segment.duration, sourceDuration: segment.sourceDuration, outputDuration: segment.outputDuration }))).toEqual([
      { duration: 15, sourceDuration: 15, outputDuration: 15 },
      { duration: 15, sourceDuration: 6, outputDuration: 15 },
    ]);
    expect(LINGGANYA_SD_2_BOARD_VIDEO_MODEL).toBe("sd-2.0");
  });

  it("reuses only clips from the exact current channel, director, schema, and target plan", () => {
    const segment = splitTargetDurationIntoVideoSegments(12)[1];
    const channel = { id: "rjmus", model: BOARD_VIDEO_MODEL, durationOptions: [10] };
    const profile = getBoardVideoProfile(channel)!;
    const director = {
      id: "director-3",
      meta: {
        directorSchemaVersion: VIDEO_DIRECTOR_SCHEMA_VERSION,
        videoCapabilitySignature: profile.capabilitySignature,
      },
    };
    const meta = {
      channelId: channel.id,
      model: BOARD_VIDEO_MODEL,
      directorNodeId: director.id,
      directorSchemaVersion: VIDEO_DIRECTOR_SCHEMA_VERSION,
      capabilitySignature: profile.capabilitySignature,
      segmentIndex: 2,
      segmentCount: 2,
      generationDuration: 10,
      sourceDuration: 2,
      outputDuration: 10,
      requestedTotalDuration: 12,
      plannedOutputDuration: 20,
      referenceNodeIds: ["base"],
    };

    expect(matchesGeneratedVideoSegment(meta, segment, channel, director)).toBe(true);
    expect(matchesGeneratedVideoSegment(meta, segment, { ...channel, id: "other" }, director)).toBe(false);
    expect(matchesGeneratedVideoSegment(meta, segment, channel, { ...director, id: "old-director" })).toBe(false);
    expect(matchesGeneratedVideoSegment(meta, segment, channel, { ...director, meta: { directorSchemaVersion: 2 } })).toBe(false);
    expect(matchesGeneratedVideoSegment({ ...meta, requestedTotalDuration: 20 }, segment, channel, director)).toBe(false);
    expect(matchesGeneratedVideoSegment({ ...meta, referenceNodeIds: ["base", "product"] }, segment, channel, director)).toBe(false);
    expect(matchesGeneratedVideoSegment({ ...meta, capabilitySignature: "old" }, segment, channel, director)).toBe(false);
  });
});
