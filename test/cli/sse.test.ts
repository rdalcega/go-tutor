import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "../../src/cli/sse.ts";

const stream = 'id: 1\ndata: {"seq":1}\n\n: keep-alive\n\nevent: tutor\nid: 2\ndata: line one\ndata: line two\n\n';

describe("SseParser", () => {
  it("parses whole messages, skipping comments", () => {
    const p = new SseParser();
    expect(p.push(stream)).toEqual([
      { event: "message", data: '{"seq":1}', id: "1" },
      { event: "tutor", data: "line one\nline two", id: "2" },
    ]);
  });

  it("gives the same result for every chunking, including one char at a time", () => {
    const whole = new SseParser().push(stream);
    for (const size of [1, 2, 3, 5, 7, 13]) {
      const p = new SseParser();
      const got: SseMessage[] = [];
      for (let i = 0; i < stream.length; i += size) got.push(...p.push(stream.slice(i, i + size)));
      expect(got).toEqual(whole);
    }
  });

  it("tracks the last event id, including from an id-only frame", () => {
    const p = new SseParser();
    expect(p.lastEventId).toBeUndefined();
    expect(p.push("id: 7\n\n")).toEqual([]);
    expect(p.lastEventId).toBe("7");
    p.push('id: 8\ndata: {"seq":8}\n\n');
    expect(p.lastEventId).toBe("8");
  });

  it("handles CRLF and CR line endings split across chunks", () => {
    const p = new SseParser();
    const got = [...p.push("data: a\r"), ...p.push("\n\r"), ...p.push("\ndata: b\r\r")];
    expect(got.map((m) => m.data)).toEqual(["a", "b"]);
  });

  it("does not dispatch until the blank line arrives", () => {
    const p = new SseParser();
    expect(p.push("data: x\n")).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("strips only one leading space and ignores retry/unknown fields", () => {
    const p = new SseParser();
    expect(p.push("retry: 100\nfoo: bar\ndata:  two\ndata\n\n")).toEqual([{ event: "message", data: " two\n" }]);
  });
});
