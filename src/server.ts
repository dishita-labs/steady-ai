/**
 * Web app (Hono, served by Nitro). The browser talks to this server only through the page
 * itself: Datastar posts forms, and the server answers with SSE events that patch the HTML.
 * There is no JSON API and no token.
 *
 * NO AUTH IN THE APP. It is a frontend behind an auth proxy (docs/decisions.md, decision 13), so it
 * has no token, login or per-user check. Anyone who can reach it can start cases and approve a
 * purchase (hook tokens are deterministic, not credentials), and each case's photo is served at
 * a public URL keyed by its case ID. Don't expose it without the proxy.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { HookNotFoundError } from "workflow/errors";
import { getRun, start } from "workflow/api";
import { stageIndex } from "./lib/case/state";
import { INTEGRATIONS, dataDir, isConfigured, type IntegrationName } from "./lib/config";
import { newId } from "./lib/ids";
import { getRepository, loadSnapshot, selectRecorder, type CaseRepository } from "./lib/recorder";
import { noteActivity, warmupStatus } from "./lib/vision/warmup";
import { sseStream } from "./ui/sse";
import { errorSlot, type CaseView, renderApp, renderPage } from "./ui/view";
import type { RoomType, UploadedImage } from "./types/domain";
import { approvalHook, approvalToken, contextHook, contextToken } from "./workflows/hooks";
import { steadyCase } from "./workflows/steady-case";
import type { ProgressEvent } from "./workflows/events";

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
/** While a run is quiet, the case stream still re-renders this often (elapsed-time hints like the vision cold start). */
const QUIET_RERENDER_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Datastar response that only sends the given patches. */
function patches(...elements: string[]): Response {
  return sseStream((sse) => {
    for (const e of elements) sse.patchElements(e);
  });
}

async function loadView(repo: CaseRepository, caseId: string, finished: boolean): Promise<CaseView | null> {
  const kase = await repo.getCase(caseId);
  if (!kase) return null;
  return { case: kase, ...(await loadSnapshot(repo, caseId)), finished };
}

app.get("/health", (c) =>
  c.json({
    ok: true,
    recorder: selectRecorder(),
    visionWarmup: warmupStatus(),
    integrations: Object.fromEntries(
      (Object.keys(INTEGRATIONS) as IntegrationName[]).map((n) => [
        n,
        { configured: isConfigured(n), verified: INTEGRATIONS[n].verified },
      ]),
    ),
  }),
);

/** New case screen. Opening it warms the vision model, so the cold start happens while a photo is being chosen. */
app.get("/", (c) => {
  noteActivity("upload page");
  return c.html(renderPage(renderApp(null)));
});

/** A case's page. Its stream fills in the rest. */
app.get("/cases/:caseId", async (c) => {
  noteActivity("case page");
  const caseId = c.req.param("caseId");
  return c.html(renderPage(renderApp(await loadView(getRepository(), caseId, false)), `/cases/${encodeURIComponent(caseId)}/stream`));
});

/**
 * Start a case. Datastar posts the upload form (multipart/form-data):
 *   photo (file, jpeg/png/webp), room, notes?, consent=true
 * Answers with an SSE patch: an error message, or a script that opens the case page.
 */
app.post("/cases", async (c) => {
  noteActivity("new case");
  const fail = (message: string) => patches(errorSlot("form-error", message).value);
  const form = await c.req.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) return fail("Choose a photo first.");
  const mimeType = MIME[photo.type];
  if (!mimeType) return fail("That image type isn't supported. Use a JPEG, PNG or WebP photo.");
  if (photo.size > MAX_UPLOAD_BYTES) return fail("That photo is too large (15 MB max).");
  if (form.get("consent") !== "true") return fail("Please confirm you're allowed to share this photo.");
  const room = String(form.get("room") ?? "unknown") as RoomType;
  if (!ROOMS.includes(room)) return fail("Choose a room from the list.");

  const bytes = new Uint8Array(await photo.arrayBuffer());
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const caseId = newId("case");
  const imageId = newId("img");
  const storageKey = `${caseId}/${imageId}.${EXT[mimeType]}`;
  await mkdir(join(dataDir(), "uploads", caseId), { recursive: true });
  await writeFile(join(dataDir(), "uploads", storageKey), bytes);

  await start(steadyCase, [
    {
      caseId,
      household: { ownership: "unknown", notes: form.get("notes")?.toString().trim() || undefined },
      image: { id: imageId, storageKey, mimeType, sha256, room, consentConfirmed: true, uploadedAt: new Date().toISOString() },
    },
  ]);
  return sseStream((sse) => {
    sse.executeScript(`window.location.assign(${JSON.stringify(`/cases/${caseId}`)})`);
  });
});

/** The case photo, for the conversation bubble. Public by design for now; see the NO AUTH note at the top. */
app.get("/cases/:caseId/photo", async (c) => {
  const image = (await getRepository().list("images", c.req.param("caseId")))[0];
  if (!image) return c.text("Not found", 404);
  const bytes = await readFile(join(dataDir(), "uploads", image.storageKey)).catch(() => null);
  if (!bytes) return c.text("Not found", 404);
  return new Response(bytes, { headers: { "content-type": image.mimeType, "cache-control": "private, max-age=3600" } });
});

/**
 * Keeps the case's `#app` current: render now, then again after every progress event the
 * run writes, then once more when the run's stream closes.
 */
app.get("/cases/:caseId/stream", async (c) => {
  const repo = getRepository();
  const caseId = c.req.param("caseId");
  return sseStream(async (sse) => {
    const push = async (finished: boolean) => {
      const view = await loadView(repo, caseId, finished);
      if (view) sse.patchElements(renderApp(view).value);
      return view;
    };
    // The workflow writes the case row in its first step, so it can lag the redirect a little.
    let view = await push(false);
    for (let i = 0; !view && i < 20; i++) {
      await sleep(500);
      view = await push(false);
    }
    if (!view?.case.workflowRunId) return;
    try {
      const reader = getRun(view.case.workflowRunId).getReadable<ProgressEvent>().getReader();
      // Re-render on every event, and also every few seconds while the run is quiet, so
      // elapsed-time hints (e.g. the vision model starting up) appear without an event.
      // Only before the photo is analyzed: later waits (questions, approval) have no timed hint.
      const analyzing = () => !!view && view.case.status === "in_progress" && stageIndex(view.case.stage) < stageIndex("PHOTO_ANALYZED");
      let next = reader.read();
      for (;;) {
        const r = await (analyzing() ? Promise.race([next, sleep(QUIET_RERENDER_MS).then(() => null)]) : next);
        if (r === null) {
          view = (await push(false)) ?? view;
          continue;
        }
        if (r.done) break;
        next = reader.read();
        view = (await push(false)) ?? view;
      }
    } finally {
      await push(true);
    }
  });
});

app.post("/cases/:caseId/context", async (c) => {
  const caseId = c.req.param("caseId");
  const skipAll = c.req.query("skip") === "1";
  const form = await c.req.formData();
  const answers = [...form.entries()]
    .filter(([k]) => k.startsWith("q:"))
    .map(([k, v]) => {
      const answer = String(v).trim();
      return { questionId: k.slice(2), ...(skipAll || !answer ? { skip: true } : { answer }) };
    });
  try {
    await contextHook.resume(contextToken(caseId), { answers, answeredBy: "web" });
    return patches();
  } catch (e) {
    if (HookNotFoundError.is(e)) return patches(errorSlot("context-error", "This case isn't waiting for answers.").value);
    throw e;
  }
});

app.post("/cases/:caseId/actions/:actionId/approval", async (c) => {
  const { caseId, actionId } = c.req.param();
  const approvedBy = String((await c.req.formData()).get("approvedBy") ?? "").trim();
  if (!approvedBy) return patches(errorSlot("approval-error", "Add your name first.").value);
  try {
    await approvalHook.resume(approvalToken(caseId, actionId), {
      actionId,
      approved: c.req.query("approved") === "true",
      approvedBy,
    });
    return patches();
  } catch (e) {
    if (HookNotFoundError.is(e)) return patches(errorSlot("approval-error", "No purchase is waiting for approval here.").value);
    throw e;
  }
});

export default app;
