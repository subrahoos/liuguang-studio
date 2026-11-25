import { describe, expect, it } from "vitest";
import type { BoardWorkflowNode } from "@/lib/board-workflows";
import { synchronizeAutomaticAudioReferences } from "@/lib/board-video-audio-sync";

function node(id: string, kind: BoardWorkflowNode["kind"], meta: Record<string, unknown> = {}): BoardWorkflowNode {
  return {
    id,
    kind,
    title: id,
    status: "done",
    meta,
    x: 0,
    y: 0,
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}

describe("automatic video-evidence audio synchronization", () => {
  it("reconnects a replaced automatic audio selection to the new audio node", () => {
    const oldAudio = node("audio-old", "audio", { assetRole: "audio_evidence" });
    const executor = node("video", "control", { directVideoReplacementAudioNodeId: oldAudio.id });
    const newAudio = node("audio-new", "audio", { assetRole: "audio_evidence" });
    const result = synchronizeAutomaticAudioReferences({
      previousNodes: [oldAudio, executor],
      nextNodes: [executor],
      previousEdges: [{ id: "manual-old-audio", from: oldAudio.id, to: executor.id, label: "手动连线" }],
      nextEdges: [],
      newAudioNode: newAudio,
    });

    expect(result.nodes[0].meta?.directVideoReplacementAudioNodeId).toBe(newAudio.id);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({ from: newAudio.id, to: executor.id, label: "手动连线" });
  });

  it("does not replace a surviving manually uploaded audio selection", () => {
    const manualAudio = node("audio-manual", "audio");
    const executor = node("video", "control", { directVideoReplacementAudioNodeId: manualAudio.id });
    const result = synchronizeAutomaticAudioReferences({
      previousNodes: [manualAudio, executor],
      nextNodes: [manualAudio, executor],
      previousEdges: [],
      nextEdges: [],
      newAudioNode: node("audio-new", "audio", { assetRole: "audio_evidence" }),
    });

    expect(result.nodes.find((item) => item.id === executor.id)?.meta?.directVideoReplacementAudioNodeId).toBe(manualAudio.id);
    expect(result.edges).toHaveLength(0);
  });

  it("clears an automatic audio selection when a new video is imported without extracting audio", () => {
    const oldAudio = node("audio-old", "audio", { assetRole: "audio_evidence" });
    const executor = node("video", "control", { directVideoReplacementAudioNodeId: oldAudio.id });
    const result = synchronizeAutomaticAudioReferences({
      previousNodes: [oldAudio, executor],
      nextNodes: [executor],
      previousEdges: [{ id: "manual-old-audio", from: oldAudio.id, to: executor.id, label: "手动连线" }],
      nextEdges: [],
      newAudioNode: null,
    });

    expect(result.nodes[0].meta?.directVideoReplacementAudioNodeId).toBeUndefined();
    expect(result.edges).toHaveLength(0);
  });
});
