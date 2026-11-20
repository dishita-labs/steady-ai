import { describe, expect, it } from "vitest";
import { sseStream } from "../src/ui/sse";

describe("sseStream", () => {
  it("sends proxy-friendly SSE headers", () => {
    const res = sseStream(() => {});
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
  });

  it("starts with a comment, then the Datastar events", async () => {
    const text = await sseStream((sse) => {
      sse.patchElements('<p id="x">hi</p>');
    }).text();
    expect(text.startsWith(": stream open\n\n")).toBe(true);
    expect(text).toContain("event: datastar-patch-elements");
    expect(text).toContain('<p id="x">hi</p>');
  });

  it("sends the preamble before a slow handler writes anything", async () => {
    let release!: () => void;
    const reader = sseStream(() => new Promise<void>((r) => (release = r))).body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(": stream open\n\n");
    release();
    await reader.cancel();
  });
});
