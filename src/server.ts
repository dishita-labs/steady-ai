/**
 * HTTP API (Hono, served by Nitro). No UI: runs are monitored in the Workflow SDK web UI
 * (`aube run workflow:web`), and `/api/runs/:runId/stream` is a Datastar SSE stub for the
 * future web app.
 *
 * Every /api route needs `Authorization: Bearer $STEADY_API_TOKEN`. Hook tokens are
 * deterministic and are NOT credentials, so this check is what stops someone from approving
 * a purchase. Real per-user auth comes with the web app.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ServerSentEventGenerator } from "@starfederation/datastar-sdk/web";
import { Hono } from "hono";
import { HookNotFoundError } from "workflow/errors";
import { getRun, start } from "workflow/api";
import { INTEGRATIONS, dataDir, isConfigured, type IntegrationName } from "./lib/config";
import { newId } from "./lib/ids";
import { getRepository, loadSnapshot, selectRecorder } from "./lib/recorder";
import type { RoomType, UploadedImage } from "./types/domain";
import type { ProgressEvent } from "./workflows/events";
import { approvalHook, approvalToken, contextHook, contextToken } from "./workflows/hooks";
import { steadyCase } from "./workflows/steady-case";

const app = new Hono();

const ROOMS: RoomType[] = ["bathroom", "stairs", "entrance", "bedroom", "hallway", "other_living_area", "unknown"];
const MIME: Record<string, UploadedImage["mimeType"]> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
};
const EXT: Record<UploadedImage["mimeType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function tokenMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    recorder: selectRecorder(),
    integrations: Object.fromEntries(
      (Object.keys(INTEGRATIONS) as IntegrationName[]).map((n) => [
        n,
        { configured: isConfigured(n), verified: INTEGRATIONS[n].verified },
      ]),
    ),
  }),
);

app.use("/api/*", async (c, next) => {
  const expected = process.env.STEADY_API_TOKEN;
  if (!expected) return c.json({ error: "STEADY_API_TOKEN is not set; the API is disabled." }, 503);
  const given = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!tokenMatches(given, expected)) return c.json({ error: "Unauthorized" }, 401);
  await next();
});

/**
 * Start a case. multipart/form-data:
 *   photo (file, jpeg/png/webp), room, consent=true, budgetMaxUsd?, ownership?, notes?
 */
app.post("/api/cases", async (c) => {
  const form = await c.req.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) return c.json({ error: "photo file is required" }, 400);
  const mimeType = MIME[photo.type];
  if (!mimeType) return c.json({ error: `unsupported image type ${photo.type}` }, 400);
  if (photo.size > MAX_UPLOAD_BYTES) return c.json({ error: "photo is too large" }, 413);
  if (form.get("consent") !== "true") return c.json({ error: "consent=true is required to analyze a home photo" }, 400);
  const room = String(form.get("room") ?? "unknown") as RoomType;
  if (!ROOMS.includes(room)) return c.json({ error: `room must be one of ${ROOMS.join(", ")}` }, 400);
  const ownership = String(form.get("ownership") ?? "unknown");
  const budget = form.get("budgetMaxUsd");

  const bytes = new Uint8Array(await photo.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const caseId = newId("case");
  const imageId = newId("img");
  const storageKey = `${caseId}/${imageId}.${EXT[mimeType]}`;
  await mkdir(join(dataDir(), "uploads", caseId), { recursive: true });
  await writeFile(join(dataDir(), "uploads", storageKey), bytes);

  const run = await start(steadyCase, [
    {
      caseId,
      household: {
        budgetMaxUsd: budget ? Number(budget) : undefined,
        ownership: ownership === "own" || ownership === "rent" ? ownership : "unknown",
        notes: form.get("notes")?.toString() || undefined,
      },
      image: { id: imageId, storageKey, mimeType, sha256, room, consentConfirmed: true, uploadedAt: new Date().toISOString() },
    },
  ]);
  return c.json({ caseId, runId: run.runId }, 202);
});

app.get("/api/cases/:caseId", async (c) => {
  const repo = getRepository();
  const caseId = c.req.param("caseId");
  const kase = await repo.getCase(caseId);
  if (!kase) return c.json({ error: "not found" }, 404);
  const [snapshot, evidence, classifications, audit] = await Promise.all([
    loadSnapshot(repo, caseId),
    repo.list("evidence", caseId),
    repo.list("classifications", caseId),
    repo.listAudit(caseId),
  ]);
  return c.json({ case: kase, ...snapshot, evidence, classifications, audit });
});

app.post("/api/cases/:caseId/context", async (c) => {
  try {
    const hook = await contextHook.resume(contextToken(c.req.param("caseId")), await c.req.json());
    return c.json({ accepted: true, runId: hook.runId });
  } catch (e) {
    if (HookNotFoundError.is(e)) return c.json({ error: "This case isn't waiting for context." }, 404);
    throw e;
  }
});

app.post("/api/cases/:caseId/actions/:actionId/approval", async (c) => {
  const { caseId, actionId } = c.req.param();
  const body = (await c.req.json()) as { approved?: unknown; approvedBy?: unknown };
  try {
    const hook = await approvalHook.resume(approvalToken(caseId, actionId), {
      actionId,
      approved: body.approved === true,
      approvedBy: typeof body.approvedBy === "string" ? body.approvedBy : "",
    });
    return c.json({ accepted: true, runId: hook.runId });
  } catch (e) {
    if (HookNotFoundError.is(e)) return c.json({ error: "No purchase is waiting for approval here." }, 404);
    throw e;
  }
});

/** Datastar SSE stub: streams progress events as signal patches. */
app.get("/api/runs/:runId/stream", (c) => {
  const run = getRun(c.req.param("runId"));
  return ServerSentEventGenerator.stream(async (sse) => {
    const reader = run.getReadable<ProgressEvent>().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      sse.patchSignals(JSON.stringify({ steady: value }));
    }
    sse.patchSignals(JSON.stringify({ steady: { runStatus: await run.status } }));
  });
});

export default app;
