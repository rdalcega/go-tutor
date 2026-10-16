import { afterEach, describe, expect, it } from "vitest";
import { httpTransport } from "../../web/src/api.ts";

class FakeEventSource {
  static last: FakeEventSource | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  close(): void {
    this.closed = true;
  }
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;

afterEach(() => {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
});

describe("httpTransport.subscribe", () => {
  it("hands each stream frame's text along with its view, so the UI can skip identical frames without re-serializing", () => {
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    const got: { gameId: unknown; raw: string | undefined }[] = [];
    const stop = httpTransport.subscribe(
      (v, raw) => got.push({ gameId: v.gameId, raw }),
      () => {},
    );
    const source = FakeEventSource.last!;
    expect(source.url).toBe("/api/events");
    const frame = JSON.stringify({ gameId: "g1" });
    source.onmessage!({ data: frame });
    source.onmessage!({ data: "{not json" }); // ignored
    expect(got).toEqual([{ gameId: "g1", raw: frame }]);
    stop();
    expect(source.closed).toBe(true);
  });
});
