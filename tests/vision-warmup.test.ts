import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chatCompletions = vi.fn();
vi.mock("../src/lib/sie", () => ({ getSieClient: () => ({ chatCompletions }) }));

describe("vision warm-up", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    chatCompletions.mockReset();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("does nothing when SIE isn't configured", async () => {
    delete process.env.SIE_API_KEY;
    const { warmVisionModel } = await import("../src/lib/vision/warmup");
    await warmVisionModel("test");
    expect(chatCompletions).not.toHaveBeenCalled();
  });

  it("shares one in-flight ping, then skips while fresh", async () => {
    process.env.SIE_API_KEY = "k";
    let release!: () => void;
    chatCompletions.mockReturnValue(new Promise<void>((r) => (release = r)));
    const { noteActivity, warmVisionModel, warmupStatus } = await import("../src/lib/vision/warmup");
    const a = warmVisionModel("a");
    const b = warmVisionModel("b");
    expect(warmupStatus().warming).toBe(true);
    release();
    await Promise.all([a, b]);
    expect(chatCompletions).toHaveBeenCalledTimes(1);
    expect(chatCompletions.mock.calls[0][0]).toMatchObject({ max_completion_tokens: 1 });
    noteActivity("page");
    expect(chatCompletions).toHaveBeenCalledTimes(1);
    expect(warmupStatus()).toMatchObject({ warming: false, keepingWarm: true });
  });

  it("never throws when the ping fails", async () => {
    process.env.SIE_API_KEY = "k";
    chatCompletions.mockRejectedValue(new Error("boom"));
    const { warmVisionModel, warmupStatus } = await import("../src/lib/vision/warmup");
    await expect(warmVisionModel("x")).resolves.toBeUndefined();
    expect(warmupStatus().lastError).toBe("boom");
  });
});
