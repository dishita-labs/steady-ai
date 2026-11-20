/**
 * Server-rendered UI. Pure functions from a case snapshot to HTML. The server sends the
 * result to the browser as Datastar `patchElements` events, so the page has no client-side
 * rendering code of its own.
 *
 *   renderApp(null)   → the "new case" screen with the upload form
 *   renderApp(view)   → conversation + decision trail for a running or finished case
 */

import { stageIndex, type CaseSnapshot, type WorkflowStage } from "../lib/case/state";
import type { HomeownerCase, ProductCandidate, ShoppingAction } from "../types/domain";
import { html, safeHref, Safe } from "./html";

export interface CaseView extends CaseSnapshot {
  case: HomeownerCase;
  /** True once the run's progress stream has closed. */
  finished: boolean;
  /** Render time (ms since epoch); defaults to now. Lets tests pin elapsed-time hints. */
  now?: number;
}

/** After this long still analyzing the photo, say the vision model is probably starting up. */
export const SLOW_VISION_HINT_MS = 12_000;

const ROOMS: [value: string, label: string][] = [
  ["unknown", "Not sure"],
  ["bathroom", "Bathroom"],
  ["stairs", "Stairs"],
  ["entrance", "Entrance"],
  ["bedroom", "Bedroom"],
  ["hallway", "Hallway"],
  ["other_living_area", "Other living area"],
];

const ACCEPT = "image/jpeg,image/png,image/webp";

// ---------------------------------------------------------------- header

function pill(v: CaseView | null): Safe {
  let label = "No case yet";
  let tone = "";
  if (v) {
    const c = v.case;
    [label, tone] = ["Case in progress", "warn"];
    if (c.status === "failed") [label, tone] = ["Case failed", "bad"];
    else if (v.actions.some((a) => a.status === "awaiting_approval")) [label, tone] = ["Needs your approval", "warn"];
    else if (v.questions.some((q) => q.status === "open")) [label, tone] = ["Needs your input", "warn"];
    else if (c.stage === "ACTION_COMPLETED" || c.status === "completed") [label, tone] = ["Case complete", "ok"];
    else if (c.status === "escalated") [label, tone] = ["Needs a person to review", "warn"];
    else if (c.status !== "in_progress") [label, tone] = ["Case paused", "warn"];
  }
  return html`<span id="pill" class="pill" data-tone="${tone}">${label}</span>`;
}

// ---------------------------------------------------------------- decision trail

export interface TrailStep {
  label: string;
  state: "done" | "active" | "waiting" | "failed" | "pending";
  sub?: string;
}

export function trail(v: CaseView | null): TrailStep[] {
  const defs: { label: string; at: WorkflowStage; waiting?: boolean; sub?: string }[] = [
    { label: "Photo analyzed", at: "PHOTO_ANALYZED" },
    { label: "Hazards identified", at: "PHOTO_ANALYZED" },
    { label: "Requirements defined", at: "REQUIREMENTS_DEFINED" },
    { label: "Researching products", at: "PRODUCTS_RESEARCHED" },
    { label: "Checking products", at: "PRODUCTS_EVALUATED" },
    { label: "Purchase request prepared", at: "PURCHASE_PREPARED" },
    { label: "Your approval", at: "ACTION_COMPLETED" },
  ];
  if (!v) return defs.map((d) => ({ label: d.label, state: "pending" }));

  const c = v.case;
  const reached = stageIndex(c.stage);
  const present = v.hazards.filter((h) => h.label === "present").length;
  const unsure = v.hazards.filter((h) => h.label === "cannot_determine").length;
  const openQ = v.questions.filter((q) => q.status === "open").length;

  defs[1].sub = reached >= 1 ? `${present} visible, ${unsure} the photo can't settle` : undefined;
  if (openQ) {
    defs[2].label = "Waiting on your answers";
    defs[2].waiting = true;
  }
  defs[2].sub = v.requirements.length ? `${v.requirements.length} product need(s)` : undefined;
  defs[3].sub = v.candidates.length ? `${v.candidates.length} candidate(s) found` : undefined;
  defs[6].waiting = v.actions.some((a) => a.status === "awaiting_approval");

  let activeFound = false;
  return defs.map((d) => {
    if (reached >= stageIndex(d.at) && !d.waiting) return { label: d.label, state: "done", sub: d.sub };
    if (activeFound) return { label: d.label, state: "pending" };
    activeFound = true;
    if (c.status === "failed") return { label: d.label, state: "failed", sub: c.statusReason || "The run stopped." };
    const state = d.waiting || c.status !== "in_progress" ? "waiting" : "active";
    const slowVision =
      state === "active" && d.at === "PHOTO_ANALYZED" && (v.now ?? Date.now()) - Date.parse(c.createdAt) > SLOW_VISION_HINT_MS;
    if (slowVision) return { label: d.label, state, sub: "Starting the vision model. The first photo after a quiet spell can take up to 2 minutes." };
    return { label: d.label, state, sub: d.sub };
  });
}

function stepItem(s: TrailStep): Safe {
  const mark = s.state === "done" ? "✓" : s.state === "failed" ? "!" : "";
  return html`<li data-state="${s.state}">
    <span class="dot" aria-hidden="true">${mark}</span>
    <span>${s.label}${s.sub ? html`<span class="sub">${s.sub}</span>` : ""}</span>
  </li>`;
}

// ---------------------------------------------------------------- conversation

function questionsMessage(v: CaseView): Safe | "" {
  const open = v.questions.filter((q) => q.status === "open");
  if (open.length === 0) return "";
  const base = `/cases/${v.case.id}/context`;
  return html`<div class="msg">
    <p>I need a bit more to go on:</p>
    <form id="context-form" data-on:submit="@post('${base}', {contentType: 'form'})">
      ${open.map(
        (q) => html`<label class="field"><span>${q.question}</span><input type="text" name="q:${q.id}" maxlength="300" /></label>`,
      )}
      <div class="row">
        <button class="primary" type="submit">Send answers</button>
        <button class="secondary" type="button" data-on:click="@post('${base}?skip=1', {contentType: 'form'})">Skip</button>
      </div>
      <p id="context-error" class="error" role="alert" hidden></p>
    </form>
  </div>`;
}

function closingMessage(v: CaseView): Safe | "" {
  const c = v.case;
  if (c.status === "failed") {
    return html`<div class="msg"><p>Something went wrong and I stopped.</p><p class="note">${c.statusReason ?? ""}</p></div>`;
  }
  if (!v.finished && c.stage !== "ACTION_COMPLETED") return "";
  const executed = v.actions.find((a) => a.status === "executed");
  let text = "I'm done for now.";
  if (executed) {
    text = executed.simulated ? "Done. This was a simulated purchase; nothing was actually bought." : "Done. The purchase went through.";
  } else if (v.actions.some((a) => a.status === "declined")) {
    text = "Okay, I didn't buy anything.";
  } else if (v.requirements.length === 0) {
    text = "I don't have a rule for anything in this photo yet, so there's nothing to shop for.";
  } else if (v.candidates.length && !v.decisions.some((d) => d.outcome === "eligible")) {
    text = "None of the products I found could be confirmed to fit, so I haven't prepared a purchase. The details are on the right.";
  }
  return html`<div class="msg"><p>${text}</p></div>`;
}

function messages(v: CaseView | null): Safe {
  const intro = html`<div class="msg"><p>Upload a room photo and tell Steady what you're concerned about.</p></div>`;
  if (!v) return html`<div id="messages" class="messages" aria-live="polite">${intro}</div>`;

  const analyzed = v.images.some((i) => i.analysisStatus === "analyzed");
  const shown = v.hazards.filter((h) => h.label === "present" || h.label === "cannot_determine");
  const hazards = !analyzed
    ? ""
    : shown.length === 0
      ? html`<div class="msg"><p>I don't see a possible hazard in this photo. That doesn't mean the room is safe; a photo only shows so much.</p></div>`
      : html`<div class="msg">
          <p>I can see ${shown.filter((h) => h.label === "present").length} possible hazard(s):</p>
          <ul>
            ${shown.map(
              (h) => html`<li>
                ${h.label === "cannot_determine" ? "I can't tell from the photo: " : ""}${h.summary}${h.location?.description ? ` (${h.location.description})` : ""}.${h.professionalAssessmentRecommended ? " A professional assessment is recommended." : ""}
              </li>`,
            )}
          </ul>
        </div>`;

  const image = v.images[0];
  return html`<div id="messages" class="messages" aria-live="polite">
    ${intro}
    <div class="msg user">
      ${image ? html`<img src="/cases/${v.case.id}/photo" alt="The photo you uploaded" />` : ""}
      <p>${v.case.household.notes || "No specific concern given."}</p>
    </div>
    ${analyzed || v.case.status === "failed" ? "" : html`<div class="msg"><p>Looking at your photo…</p></div>`}
    ${hazards} ${questionsMessage(v)} ${closingMessage(v)}
  </div>`;
}

function composer(): Safe {
  return html`<form id="composer" class="composer" enctype="multipart/form-data" autocomplete="off"
    data-signals="{consent: false, fileName: ''}"
    data-on:submit="@post('/cases', {contentType: 'form'})">
    <label class="upload">
      <input type="file" name="photo" accept="${ACCEPT}" required hidden
        data-on:change="$fileName = evt.target.files[0]?.name ?? ''" />
      <span class="upload-text">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7" /><path d="M4 17l4.5-4.5 3 3 2-2L20 18" /><path d="M18 3v6M15 6h6" />
        </svg>
        <span data-text="$fileName || 'Upload photo'">Upload photo</span>
      </span>
    </label>
    <label class="field">
      <span>Room</span>
      <select name="room">${ROOMS.map(([value, label]) => html`<option value="${value}">${label}</option>`)}</select>
    </label>
    <label class="field">
      <span>What are you concerned about? <em>(optional)</em></span>
      <textarea name="notes" rows="2" maxlength="1000" placeholder="e.g. Dad slipped getting out of the tub last month"></textarea>
    </label>
    <label class="consent">
      <input type="checkbox" name="consent" value="true" data-bind:consent />
      <span>I'm allowed to share this photo of the home for analysis.</span>
    </label>
    <button class="primary" type="submit" data-attr:disabled="!$consent">Start case</button>
    <p id="form-error" class="error" role="alert" hidden></p>
  </form>`;
}

// ---------------------------------------------------------------- shopping request

type Verdict = "eligible" | "needs_verification" | "rejected";
const VERDICT_LABEL: Record<Verdict, string> = { eligible: "Fits", needs_verification: "Needs checking", rejected: "Doesn't fit" };

function candidateCard(cand: ProductCandidate, v: CaseView): Safe {
  const dec = v.decisions.filter((d) => d.candidateId === cand.id);
  const verdict: Verdict | null = !dec.length
    ? null
    : dec.some((d) => d.outcome === "rejected")
      ? "rejected"
      : dec.every((d) => d.outcome === "eligible")
        ? "eligible"
        : "needs_verification";
  const notes = [...new Set(dec.flatMap((d) => d.notes))];
  const href = safeHref(cand.url);
  return html`<div class="cand">
    <div>
      ${verdict ? html`<span class="badge ${verdict}">${VERDICT_LABEL[verdict]}</span>` : ""}
      ${href ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${cand.title}</a>` : cand.title}
    </div>
    ${cand.retailer ? html`<span class="muted">${cand.retailer}</span>` : ""}
    ${notes.map((n) => html`<span class="muted">${n}</span>`)}
  </div>`;
}

function approvalCard(a: ShoppingAction, v: CaseView): Safe {
  const base = `/cases/${v.case.id}/actions/${a.id}/approval`;
  const titles = a.candidateIds.map((id) => v.candidates.find((c) => c.id === id)?.title ?? id);
  return html`<form id="approval-form" class="approval">
    <strong>${a.simulated ? "Approve this purchase request (simulated)" : "Approve this purchase request"}</strong>
    <ul>${titles.map((t) => html`<li>${t}</li>`)}</ul>
    <p class="muted">Prices come from page text and may be out of date. Nothing is bought until you approve.</p>
    <input id="approver" type="text" name="approvedBy" maxlength="80" placeholder="Your name" aria-label="Your name" required />
    <div class="row">
      <button class="primary" type="button" data-on:click="@post('${base}?approved=true', {contentType: 'form'})">Approve</button>
      <button class="secondary" type="button" data-on:click="@post('${base}?approved=false', {contentType: 'form'})">Decline</button>
    </div>
    <p id="approval-error" class="error" role="alert" hidden></p>
  </form>`;
}

function shopping(v: CaseView | null): Safe {
  if (!v || v.candidates.length === 0) {
    return html`<div id="shopping" class="shopping"><p class="muted">Awaiting product evaluation</p></div>`;
  }
  const pending = v.actions.find((a) => a.status === "awaiting_approval");
  const settled = v.actions.filter((a) => ["executed", "declined", "failed"].includes(a.status));
  return html`<div id="shopping" class="shopping">
    ${pending ? approvalCard(pending, v) : ""}
    ${settled.map(
      (a) => html`<p class="${a.status === "failed" ? "error" : "muted"}">Purchase request ${a.status}${a.simulated ? " (simulated)" : ""}.${a.error ? ` ${a.error}` : ""}</p>`,
    )}
    ${v.candidates.map((c) => candidateCard(c, v))}
  </div>`;
}

// ---------------------------------------------------------------- app

/** Everything the stream patches. The element keeps the id `app`, which is how Datastar finds it. */
export function renderApp(v: CaseView | null): Safe {
  return html`<div id="app" class="shell">
    <header class="top">
      <div class="brand">
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z" /><path d="M8.8 12.2l2.2 2.2 4.2-4.4" />
        </svg>
        <h1>Steady</h1>
      </div>
      <div class="top-right">${pill(v)}</div>
    </header>
    <main class="panes">
      <section class="pane" aria-labelledby="conv-h">
        <h2 id="conv-h">Conversation</h2>
        ${messages(v)} ${v ? "" : composer()}
        <p class="foot">Steady describes what a photo shows. It isn't a safety inspection, and a photo can't confirm that something is installed safely.</p>
      </section>
      <aside class="pane trail" aria-labelledby="trail-h">
        <h2 id="trail-h">Decision trail</h2>
        <ol class="steps">${trail(v).map(stepItem)}</ol>
        <hr />
        <h3>Shopping request</h3>
        ${shopping(v)}
      </aside>
    </main>
  </div>`;
}

/** The full page. `streamUrl` is set on a case page; its stream keeps `#app` up to date. */
export function renderPage(app: Safe, streamUrl?: string): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Steady</title>
        <link rel="stylesheet" href="/app.css" />
        <script type="module" src="https://cdn.jsdelivr.net/gh/starfederation/datastar@1.0.0/bundles/datastar.js"></script>
      </head>
      <body>
        ${app}
        ${streamUrl ? html`<div hidden data-init="@get('${streamUrl}')"></div>` : ""}
      </body>
    </html>`.value;
}

/** A small message patched into an error slot, e.g. `#form-error`. */
export function errorSlot(id: string, message: string): Safe {
  return html`<p id="${id}" class="error" role="alert">${message}</p>`;
}
