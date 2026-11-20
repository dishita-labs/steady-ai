/**
 * Keeps the Gemma vision model warm on SIE Serverless so the first photo doesn't wait for a cold start.
 *
 * Why: Serverless scales the pinned H100 profile to zero when idle. The next `describePhoto`
 * then waits about 2 minutes while the SDK quietly retries `503 PROVISIONING` / `MODEL_LOADING`
 * (`waitForCapacity` defaults to true). Once the model is loaded, a call answers in under a second.
 *
 * How: any page activity (`noteActivity`) sends a 1-token text ping to the same model ID, so the
 * cold start happens while the user is still choosing a photo. While the app is in use, a timer
 * re-pings every few minutes. It stops after `SIE_KEEP_WARM_MINUTES` (default 30) with no
 * activity, so an idle server doesn't keep a GPU busy.
 *
 * Best effort: never throws, and does nothing when SIE isn't configured.
 */

import { envOr, isConfigured } from "../config";
import { getSieClient } from "../sie";

const PING_EVERY_MS = 3 * 60_000;

export interface WarmupStatus {
  warming: boolean;
  /** When the last ping succeeded (ISO). */
  lastWarmAt?: string;
  lastDurationMs?: number;
  lastError?: string;
}

const state: { inflight?: Promise<void>; lastWarmAt: number; lastActivityAt: number; timer?: ReturnType<typeof setInterval>; status: WarmupStatus } = {
  lastWarmAt: 0,
  lastActivityAt: 0,
  status: { warming: false },
};

function keepWarmMs(): number {
  const minutes = Number(process.env.SIE_KEEP_WARM_MINUTES ?? 30);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : 30 * 60_000;
}

/** Ping the vision model once. Concurrent callers share the same in-flight ping. */
export function warmVisionModel(reason: string): Promise<void> {
  if (!isConfigured("sie-vision")) return Promise.resolve();
  state.inflight ??= (async () => {
    const model = envOr("sie-vision", "SIE_VISION_MODEL");
    const started = Date.now();
    state.status = { ...state.status, warming: true };
    try {
      await getSieClient().chatCompletions({ model, messages: [{ role: "user", content: "ok" }], max_completion_tokens: 1 });
      const ms = Date.now() - started;
      state.lastWarmAt = Date.now();
      state.status = { warming: false, lastWarmAt: new Date(state.lastWarmAt).toISOString(), lastDurationMs: ms };
      console.info(`[warmup] ${model} ready in ${ms} ms (${reason})`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      state.status = { ...state.status, warming: false, lastError: message };
      console.warn(`[warmup] ${model} ping failed after ${Date.now() - started} ms (${reason}): ${message}`);
    } finally {
      state.inflight = undefined;
    }
  })();
  return state.inflight;
}

/**
 * Someone is using the app: warm the model now unless it was pinged recently, and keep it
 * warm until activity stops. Fire-and-forget; safe to call on every request.
 */
export function noteActivity(reason: string): void {
  if (!isConfigured("sie-vision") || keepWarmMs() === 0) return;
  state.lastActivityAt = Date.now();
  if (Date.now() - state.lastWarmAt > PING_EVERY_MS) void warmVisionModel(reason);
  if (!state.timer) {
    state.timer = setInterval(() => {
      if (Date.now() - state.lastActivityAt > keepWarmMs()) {
        clearInterval(state.timer);
        state.timer = undefined;
        console.info("[warmup] no activity; letting the vision model idle");
        return;
      }
      void warmVisionModel("keep-warm");
    }, PING_EVERY_MS);
    state.timer.unref?.();
  }
}

export function warmupStatus(): WarmupStatus & { keepingWarm: boolean } {
  return { ...state.status, keepingWarm: state.timer !== undefined };
}
