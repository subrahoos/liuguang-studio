import { describe, expect, it } from "vitest";
import { ProductionSaveLedger } from "@/lib/product-production-save-ledger";

describe("production save latest-field intent", () => {
  it("never replays old seconds after newer seconds have saved", () => {
    const ledger = new ProductionSaveLedger();
    const old = ledger.begin({ videoChannelId: "a", defaultVideoSeconds: 10, defaultVideoResolution: "720p" });
    ledger.fail(old);
    const newer = ledger.begin({ defaultVideoSeconds: 15 });
    ledger.succeed(newer);
    expect(ledger.retryPatches()).toEqual([{ videoChannelId: "a" }, { defaultVideoResolution: "720p" }]);
    expect(ledger.currentPatch(old)).toEqual({ videoChannelId: "a", defaultVideoResolution: "720p" });
  });
  it("ignores a late failure of a superseded request", () => {
    const ledger = new ProductionSaveLedger();
    const old = ledger.begin({ name: "old" });
    const newer = ledger.begin({ name: "new" });
    ledger.succeed(newer); ledger.fail(old);
    expect(ledger.hasFailures).toBe(false);
    expect(ledger.currentPatch(old)).toEqual({});
  });
  it("does not let an old success clear a newer failure", () => {
    const ledger = new ProductionSaveLedger();
    const old = ledger.begin({ name: "old" });
    const newer = ledger.begin({ name: "new" });
    ledger.fail(newer); ledger.succeed(old);
    expect(ledger.retryPatches()).toEqual([{ name: "new" }]);
  });
  it("isolates per-source fields and retains distinct removal commands", () => {
    const ledger = new ProductionSaveLedger();
    ledger.fail(ledger.begin({ videoSourceUpdate: { id: "a", patch: { channelId: "model-a", copies: 1 } } }));
    ledger.fail(ledger.begin({ videoSourceUpdate: { id: "b", patch: { copies: 2 } } }));
    ledger.succeed(ledger.begin({ videoSourceUpdate: { id: "a", patch: { copies: 5 } } }));
    ledger.fail(ledger.begin({ removeAssetId: "first" }));
    ledger.fail(ledger.begin({ removeAssetId: "second" }));
    expect(ledger.retryPatches()).toEqual([
      { videoSourceUpdate: { id: "a", patch: { channelId: "model-a" } } },
      { videoSourceUpdate: { id: "b", patch: { copies: 2 } } },
      { removeAssetId: "first" }, { removeAssetId: "second" },
    ]);
    ledger.clear(); expect(ledger.hasFailures).toBe(false);
  });
});
