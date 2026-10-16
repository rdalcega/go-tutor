import { describe, expect, it } from "vitest";
import { readCollapsed, writeCollapsed } from "../../web/src/collapse.ts";

function memoryStore(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("collapsed cards", () => {
  it("remembers each card on its own, and an open card leaves no entry", () => {
    const store = memoryStore();
    expect(readCollapsed("eval", store)).toBe(false);
    writeCollapsed("eval", true, store);
    expect(readCollapsed("eval", store)).toBe(true);
    expect(readCollapsed("progress", store)).toBe(false);
    writeCollapsed("eval", false, store);
    expect(readCollapsed("eval", store)).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it("starts open and never throws when storage is missing or refuses", () => {
    expect(readCollapsed("eval", null)).toBe(false);
    expect(() => writeCollapsed("eval", true, null)).not.toThrow();
    expect(readCollapsed("eval", throwing)).toBe(false);
    expect(() => writeCollapsed("eval", true, throwing)).not.toThrow();
    expect(() => writeCollapsed("eval", false, throwing)).not.toThrow();
    // Under Node there is no localStorage: the default store is simply absent.
    expect(readCollapsed("eval")).toBe(false);
  });
});
