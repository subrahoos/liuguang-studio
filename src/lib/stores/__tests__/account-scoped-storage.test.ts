// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  accountScopedStateStorage,
  hasAccountScopedStore,
  scopedStorageKey,
  setBrowserAccountScope,
} from "../account-scoped-storage";

describe("account scoped browser storage", () => {
  beforeEach(() => window.localStorage.clear());

  it("keeps the same store name isolated between users", () => {
    setBrowserAccountScope("user-a");
    accountScopedStateStorage.setItem("daihuo-jianshou-products", "A");

    setBrowserAccountScope("user-b");
    expect(accountScopedStateStorage.getItem("daihuo-jianshou-products")).toBeNull();
    accountScopedStateStorage.setItem("daihuo-jianshou-products", "B");

    setBrowserAccountScope("user-a");
    expect(accountScopedStateStorage.getItem("daihuo-jianshou-products")).toBe("A");
    expect(scopedStorageKey("daihuo-jianshou-products")).toBe("daihuo-jianshou-products:user-a");
  });

  it("migrates legacy data only when explicitly requested", () => {
    window.localStorage.setItem("daihuo-jianshou-settings", "legacy-admin-settings");

    setBrowserAccountScope("admin-user", true);
    expect(hasAccountScopedStore("daihuo-jianshou-settings")).toBe(true);
    expect(accountScopedStateStorage.getItem("daihuo-jianshou-settings")).toBe("legacy-admin-settings");

    setBrowserAccountScope("normal-user", false);
    expect(hasAccountScopedStore("daihuo-jianshou-settings")).toBe(false);
    expect(accountScopedStateStorage.getItem("daihuo-jianshou-settings")).toBeNull();
  });
});
