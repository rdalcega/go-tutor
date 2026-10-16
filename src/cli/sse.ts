// Incremental Server-Sent Events parser (https://html.spec.whatwg.org/multipage/server-sent-events.html).
// Feed it decoded text chunks in any split; it returns the events completed by each chunk.

export interface SseMessage {
  /** The `event:` field, "message" when absent. */
  event: string;
  /** The `data:` lines joined with "\n". */
  data: string;
  /** The last `id:` seen on this message, if any. */
  id?: string;
}

export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private lastId: string | undefined;
  /** A chunk ended with "\r": a following "\n" belongs to the same line ending. */
  private pendingCr = false;

  push(chunk: string): SseMessage[] {
    if (this.pendingCr && chunk.startsWith("\n")) chunk = chunk.slice(1);
    this.pendingCr = false;
    this.buffer += chunk;

    const out: SseMessage[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) break;
      // A trailing lone "\r" might be the first half of "\r\n" split across chunks.
      if (match[0] === "\r" && match.index === this.buffer.length - 1) {
        this.pendingCr = true;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = this.line(line);
      if (message) out.push(message);
    }
    return out;
  }

  private line(line: string): SseMessage | null {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return null; // comment / keep-alive

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      // "retry" and unknown fields are ignored: reconnection timing is ours.
    }
    return null;
  }

  /**
   * The last event ID string. Like EventSource's, it is set at each blank line, including by
   * frames with an `id:` but no data (a server's cursor-only frame).
   */
  get lastEventId(): string | undefined {
    return this.lastId;
  }

  private dispatch(): SseMessage | null {
    const hadData = this.data.length > 0;
    if (this.id !== undefined) this.lastId = this.id;
    const message: SseMessage = { event: this.event || "message", data: this.data.join("\n") };
    if (this.id !== undefined) message.id = this.id;
    this.data = [];
    this.event = "";
    return hadData ? message : null;
  }
}
