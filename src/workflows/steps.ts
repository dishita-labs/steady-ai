/**
 * Workflow steps for a Steady case. Each "use step" function runs with full Node access,
 * is retried on unhandled errors, and is recorded in the Workflow SDK run trace.
 *
 * Every step:
 *   1. reads what it needs from the recorder (never trusts large payloads passed in),
 *   2. writes results with deterministic IDs (so retries upsert instead of duplicating),
 *   3. appends audit events,
 *   4. re-derives the case stage/status from the snapshot (`syncCase`) and emits a progress event.
 *
 * Steps return small summaries only: the recorder is the system of record.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FatalError, getStepMetadata, getWritable } from "workflow";
import { createAuditEvent, type NewAuditEvent } from "../lib/audit";
import { deriveStatus, tryAdvance, type CaseStatus, type WorkflowStage } from "../lib/case/state";
import { dataDir, envOr } from "../lib/config";
import { newId, stableId } from "../lib/ids";
import { deriveAttributes } from "../lib/product-fitness/attributes";
import { CHECKLISTS, type ProductType } from "../lib/product-fitness/checklist";
import { productPageCheck } from "../lib/product-fitness/page";
import { maxYes, readChecklist } from "../lib/product-fitness/read";
import { parseSheet, SHEET_QUERY, SHEET_SCHEMA, sheetText, verifySheet } from "../lib/product-fitness/sheet";
import { SHOPS_FOR } from "../lib/product-fitness/shops";
import { getProductSearchProvider } from "../lib/product-search";
import { getRepository, loadSnapshot, type CaseRepository } from "../lib/recorder";
import { evaluateCandidate, selectForPurchase } from "../lib/rules/engine";
import { deriveRequirements, ruleFor } from "../lib/rules/requirements";
import { approve, executeApproved, getShoppingAdapter } from "../lib/shopping";
import { getVisionAnalyzer, validateVisionResult } from "../lib/vision";
import { classifyObservations, type ClassifyResult } from "../lib/vision/observe-classify/classify";
import { describeImage, ObservationContractError, ObservationOutput } from "../lib/vision/observe-classify/observe";
import { DEFAULT_VALIDATOR, traceProblems, validateClassifications } from "../lib/vision/observe-classify/validate";
import type {
  HazardFinding,
  HomeownerCase,
  HouseholdContext,
  ProductCandidate,
  ProductClassification,
  ProductEvidence,
  TypedAnswer,
  UploadedImage,
} from "../types/domain";
import type { ProgressEvent } from "./events";

// ---------------------------------------------------------------------------
// Helpers (plain functions, called from inside steps)
// ---------------------------------------------------------------------------

async function audit(repo: CaseRepository, e: NewAuditEvent) {
  await repo.appendAudit(createAuditEvent(e));
}

async function emit(event: Omit<ProgressEvent, "at">) {
  const writer = getWritable<ProgressEvent>().getWriter();
  try {
    await writer.write({ ...event, at: new Date().toISOString() });
  } finally {
    writer.releaseLock();
  }
}

export interface CaseState {
  stage: WorkflowStage;
  status: CaseStatus;
}

/** Advance the stage as far as the gates allow, derive status, persist and audit changes, emit progress. */
async function syncCase(
  repo: CaseRepository,
  caseId: string,
  step: string,
  message: string,
  waitingOn?: ProgressEvent["waitingOn"],
): Promise<CaseState> {
  const c = await repo.getCase(caseId);
  if (!c) throw new FatalError(`Case ${caseId} not found`);
  const snap = await loadSnapshot(repo, caseId);
  let stage = c.stage;
  let blockers: string[];
  for (;;) {
    const r = tryAdvance(stage, snap);
    blockers = r.blockers;
    if (!r.advanced) break;
    await audit(repo, {
      caseId,
      type: "case.stage_changed",
      actor: { kind: "system", id: "workflow" },
      stage: r.stage,
      summary: `${stage} → ${r.stage}`,
    });
    stage = r.stage;
  }
  const status = deriveStatus(stage, snap);
  if (status !== c.status) {
    await audit(repo, {
      caseId,
      type: "case.status_changed",
      actor: { kind: "system", id: "workflow" },
      stage,
      summary: `${c.status} → ${status}`,
      data: { blockers },
    });
  }
  await repo.updateCase(caseId, { stage, status, statusReason: status === "in_progress" ? undefined : blockers.join(" ") });
  await emit({ caseId, step, stage, status, message, waitingOn });
  return { stage, status };
}

/**
 * Run a step body; if it fails for good (a fatal error, or the last retry), durably record
 * the failure on the case and close the progress stream before rethrowing.
 *
 * Failure handling lives here rather than in a try/catch in the workflow body because the
 * Workflow UI graph is built from the workflow body, and the compiler skips `try` blocks.
 */
async function guarded<T>(caseId: string, step: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (e) {
    const { attempt, maxAttempts } = getStepMetadata();
    if (FatalError.is(e) || isPermanentRequestError(e) || attempt >= maxAttempts) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await recordFailure(caseId, step, message);
      } finally {
        await getWritable<ProgressEvent>().close();
      }
    }
    throw isPermanentRequestError(e) ? new FatalError((e as Error).message) : e;
  }
}

/**
 * A 4xx from an SDK (SIE `RequestError`, Exa, …) won't succeed on retry, except 408/429.
 * Matched by shape, not `instanceof`, because bundling can duplicate SDK classes.
 */
export function isPermanentRequestError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const status = (e as { statusCode?: unknown; status?: unknown }).statusCode ?? (e as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

async function recordFailure(caseId: string, step: string, message: string) {
  const repo = getRepository();
  const c = await repo.getCase(caseId);
  if (!c) return;
  await audit(repo, {
    caseId,
    type: "integration.error",
    actor: { kind: "system", id: "workflow" },
    stage: c.stage,
    summary: `Run stopped in ${step}: ${message}`,
  });
  if (c.status !== "failed") {
    await audit(repo, {
      caseId,
      type: "case.status_changed",
      actor: { kind: "system", id: "workflow" },
      stage: c.stage,
      summary: `${c.status} → failed`,
    });
  }
  await repo.updateCase(caseId, { status: "failed", statusReason: message });
  await emit({ caseId, step, stage: c.stage, status: "failed", message });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface StartCaseInput {
  caseId: string;
  household: HouseholdContext;
  image: Omit<UploadedImage, "caseId" | "analysisStatus">;
}

export async function recordCase(input: StartCaseInput, workflowRunId: string): Promise<CaseState> {
  "use step";
  return guarded(input.caseId, "recordCase", async () => {
    const repo = getRepository();
    const now = new Date().toISOString();
    if (!(await repo.getCase(input.caseId))) {
      const c: HomeownerCase = {
        id: input.caseId,
        createdAt: now,
        updatedAt: now,
        stage: "CASE_CREATED",
        status: "in_progress",
        household: input.household,
        workflowRunId,
      };
      await repo.createCase(c);
      await repo.upsert("images", { ...input.image, caseId: input.caseId, analysisStatus: "pending" });
      await audit(repo, {
        caseId: input.caseId,
        type: "case.created",
        actor: { kind: "user", id: "api" },
        stage: "CASE_CREATED",
        summary: `Case created with one ${input.image.room} photo (recorder: ${repo.kind}).`,
        data: { workflowRunId, imageId: input.image.id, consentConfirmed: input.image.consentConfirmed },
      });
    }
    return syncCase(repo, input.caseId, "recordCase", "Case recorded.");
  });
}

/**
 * Gemma-only vision (one call, Gemma labels H01–H11 directly). Not used by the workflow since the
 * describe → classify → finalize steps below replaced it; kept so switching back is one line in
 * steady-case.ts.
 */
export async function analyzePhoto(caseId: string, imageId: string): Promise<CaseState & { hazards: number }> {
  "use step";
  return guarded(caseId, "analyzePhoto", async () => {
    const repo = getRepository();
    const c = await repo.getCase(caseId);
    const image = (await repo.list("images", caseId)).find((i) => i.id === imageId);
    if (!c || !image) throw new FatalError(`Image ${imageId} not found for case ${caseId}`);

    const bytes = await readFile(join(dataDir(), "uploads", image.storageKey));
    const started = Date.now();
    const result = await getVisionAnalyzer().analyze({ image, bytes, household: c.household });
    const problems = validateVisionResult(result);
    const toolCall = {
      provider: "sie-vision" as const,
      operation: "chat.completions",
      ok: problems.length === 0,
      durationMs: Date.now() - started,
      externalRef: result.source.externalRef,
    };

    if (problems.length) {
      await repo.upsert("images", { ...image, analysisStatus: "failed" });
      await audit(repo, {
        caseId,
        type: "integration.error",
        actor: { kind: "tool", id: "sie-vision" },
        stage: c.stage,
        subject: { kind: "image", id: imageId },
        summary: "Vision output broke the contract; nothing was stored.",
        data: { problems, model: result.source.model },
        toolCall,
      });
      // Not retryable by default: the same input usually gives the same broken output.
      throw new FatalError(`Vision output invalid: ${problems.join(" ")}`);
    }

    const hazards: HazardFinding[] = result.findings.map((f, i) => ({
      ...f,
      id: stableId("haz", imageId, f.category, i),
      caseId,
      imageId,
      source: result.source,
    }));
    for (const h of hazards) await repo.upsert("hazards", h);
    await repo.upsert("images", { ...image, analysisStatus: "analyzed" });
    await audit(repo, {
      caseId,
      type: "vision.analyzed",
      actor: { kind: "tool", id: "sie-vision" },
      stage: c.stage,
      subject: { kind: "image", id: imageId },
      summary: `${hazards.filter((h) => h.label === "present").length} present, ${hazards.filter((h) => h.label === "cannot_determine").length} cannot-determine.`,
      data: { categoryLabels: result.categoryLabels, uncertainties: result.uncertainties, hazardIds: hazards.map((h) => h.id) },
      toolCall,
    });
    const s = await syncCase(repo, caseId, "analyzePhoto", `Photo analyzed: ${hazards.length} finding(s).`);
    return { ...s, hazards: hazards.length };
  });
}

// ---------------------------------------------------------------------------
// Vision: describe (Gemma) → classify (GLiNER) → finalize (deterministic rules).
// See src/lib/vision/observe-classify/ and experiments/hazard-classification/REPORT.md.
// Each step stores its output in the audit trail as observable facts (no model reasoning);
// the next step reads it back from the recorder, so step returns stay small.
// ---------------------------------------------------------------------------

type ClassifiedReads = Omit<ClassifyResult, "calls">;

async function loadImage(repo: CaseRepository, caseId: string, imageId: string) {
  const c = await repo.getCase(caseId);
  const image = (await repo.list("images", caseId)).find((i) => i.id === imageId);
  if (!c || !image) throw new FatalError(`Image ${imageId} not found for case ${caseId}`);
  return { c, image };
}

/** The latest audit event of this type for the image (a retried step may have written more than one). */
async function latestVisionData<T>(repo: CaseRepository, caseId: string, imageId: string, type: "vision.described" | "vision.classified"): Promise<T> {
  const e = (await repo.listAudit(caseId)).filter((x) => x.type === type && x.subject?.id === imageId).at(-1);
  if (!e?.data) throw new FatalError(`No ${type} record for image ${imageId}.`);
  return e.data as T;
}

/** Vision 1/3: Gemma 4 describes the photo neutrally: objects, parts, explicit empty lists. No hazard judgement. */
export async function describePhoto(caseId: string, imageId: string): Promise<CaseState & { observations: number }> {
  "use step";
  return guarded(caseId, "describePhoto", async () => {
    const repo = getRepository();
    const { c, image } = await loadImage(repo, caseId, imageId);
    const bytes = await readFile(join(dataDir(), "uploads", image.storageKey));
    const started = Date.now();
    try {
      const d = await describeImage({ bytes, mimeType: image.mimeType, room: image.room });
      await audit(repo, {
        caseId,
        type: "vision.described",
        actor: { kind: "tool", id: "sie-vision" },
        stage: c.stage,
        subject: { kind: "image", id: imageId },
        summary: `${d.output.observations.length} observation(s), ${d.output.observations.filter((o) => o.parts.length).length} structure(s) with parts.`,
        data: { observations: d.output, model: d.model },
        toolCall: { provider: "sie-vision", operation: "chat.completions", ok: true, durationMs: Date.now() - started, externalRef: d.externalRef },
      });
      const s = await syncCase(repo, caseId, "describePhoto", `Photo described: ${d.output.observations.length} observation(s).`);
      return { ...s, observations: d.output.observations.length };
    } catch (e) {
      if (e instanceof ObservationContractError) {
        await repo.upsert("images", { ...image, analysisStatus: "failed" });
        await audit(repo, {
          caseId,
          type: "integration.error",
          actor: { kind: "tool", id: "sie-vision" },
          stage: c.stage,
          subject: { kind: "image", id: imageId },
          summary: "Photo description broke the contract; nothing was stored.",
          data: { problem: e.message },
          toolCall: { provider: "sie-vision", operation: "chat.completions", ok: false, durationMs: Date.now() - started },
        });
      }
      throw e;
    }
  });
}

/** Vision 2/3: GLiNER2.5 Decide answers one positive yes/no per request about each part and item (texts batched). */
export async function classifyPhoto(caseId: string, imageId: string): Promise<CaseState & { reads: number }> {
  "use step";
  return guarded(caseId, "classifyPhoto", async () => {
    const repo = getRepository();
    const { c } = await loadImage(repo, caseId, imageId);
    const { observations } = await latestVisionData<{ observations: unknown }>(repo, caseId, imageId, "vision.described");
    const obs = ObservationOutput.parse(observations);
    const started = Date.now();
    const { calls, ...classified } = await classifyObservations(obs, 4, "batch-texts", true);
    await audit(repo, {
      caseId,
      type: "vision.classified",
      actor: { kind: "tool", id: "sie-decide" },
      stage: c.stage,
      subject: { kind: "image", id: imageId },
      summary: `${calls.length} yes/no read(s) over ${classified.parts.length} part(s).`,
      data: { classified, model: envOr("sie-decide", "SIE_DECIDE_MODEL") },
      toolCall: { provider: "sie-decide", operation: "extract", ok: true, durationMs: Date.now() - started },
    });
    const s = await syncCase(repo, caseId, "classifyPhoto", `Observations classified: ${calls.length} read(s).`);
    return { ...s, reads: calls.length };
  });
}

/** Vision 3/3: deterministic evidence rules turn reads into H01–H11 findings; only PRESENT reaches shopping. */
export async function finalizeHazards(caseId: string, imageId: string): Promise<CaseState & { hazards: number }> {
  "use step";
  return guarded(caseId, "finalizeHazards", async () => {
    const repo = getRepository();
    const { c, image } = await loadImage(repo, caseId, imageId);
    const obs = ObservationOutput.parse((await latestVisionData<{ observations: unknown }>(repo, caseId, imageId, "vision.described")).observations);
    const { classified } = await latestVisionData<{ classified: ClassifiedReads }>(repo, caseId, imageId, "vision.classified");
    const source = {
      provider: "sie-vision" as const,
      model: `describe:${envOr("sie-vision", "SIE_VISION_MODEL")} + classify:${envOr("sie-decide", "SIE_DECIDE_MODEL")}`,
      at: new Date().toISOString(),
    };
    const result = validateClassifications(obs, { ...classified, calls: [] }, source, DEFAULT_VALIDATOR);
    const problems = [...validateVisionResult(result), ...traceProblems(result, obs)];
    if (problems.length) {
      await repo.upsert("images", { ...image, analysisStatus: "failed" });
      await audit(repo, {
        caseId,
        type: "integration.error",
        actor: { kind: "system", id: "evidence-validator" },
        stage: c.stage,
        subject: { kind: "image", id: imageId },
        summary: "Hazard findings broke the contract; nothing was stored.",
        data: { problems },
      });
      throw new FatalError(`Hazard findings invalid: ${problems.join(" ")}`);
    }

    const hazards: HazardFinding[] = result.findings.map((f, i) => ({ ...f, id: stableId("haz", imageId, f.category, i), caseId, imageId, source }));
    for (const h of hazards) await repo.upsert("hazards", h);
    await repo.upsert("images", { ...image, analysisStatus: "analyzed" });
    await audit(repo, {
      caseId,
      type: "vision.analyzed",
      actor: { kind: "system", id: "evidence-validator" },
      stage: c.stage,
      subject: { kind: "image", id: imageId },
      summary: `${hazards.filter((h) => h.label === "present").length} present, ${hazards.filter((h) => h.label === "cannot_determine").length} cannot-determine.`,
      data: {
        strategy: "describe-classify",
        validator: DEFAULT_VALIDATOR,
        categoryLabels: result.categoryLabels,
        uncertainties: result.uncertainties,
        hazardIds: hazards.map((h) => h.id),
        // Which observation parts decided each label, and why: the decision trail.
        trace: result.trace,
      },
    });
    const s = await syncCase(repo, caseId, "finalizeHazards", `Photo analyzed: ${hazards.length} finding(s).`);
    return { ...s, hazards: hazards.length };
  });
}

export async function defineRequirements(caseId: string): Promise<CaseState & { openQuestionIds: string[]; requirementIds: string[] }> {
  "use step";
  return guarded(caseId, "defineRequirements", async () => {
    const repo = getRepository();
    const hazards = await repo.list("hazards", caseId);
    const { requirements, questions, unmatched } = deriveRequirements(caseId, hazards);
    for (const r of requirements) {
      await repo.upsert("requirements", r);
      await audit(repo, {
        caseId,
        type: "requirement.defined",
        actor: { kind: "system", id: "rules-engine" },
        stage: "PHOTO_ANALYZED",
        subject: { kind: "requirement", id: r.id },
        summary: `${r.productType} from rule ${r.ruleId} (${r.status}).`,
        data: { ruleId: r.ruleId, hazardIds: r.hazardIds, mandatory: r.mandatory.length },
      });
    }
    for (const q of questions) {
      await repo.upsert("questions", q);
      await audit(repo, {
        caseId,
        type: "context.question_asked",
        actor: { kind: "system", id: "rules-engine" },
        stage: "PHOTO_ANALYZED",
        subject: { kind: "question", id: q.id },
        summary: q.question,
      });
    }
    if (unmatched.length) {
      await audit(repo, {
        caseId,
        type: "requirement.defined",
        actor: { kind: "system", id: "rules-engine" },
        stage: "PHOTO_ANALYZED",
        summary: `No requirement rule for: ${unmatched.join(", ")}.`,
        data: { unmatched },
      });
    }
    const openQuestionIds = questions.map((q) => q.id);
    const s = await syncCase(repo, caseId, "defineRequirements", `${requirements.length} requirement(s), ${openQuestionIds.length} open question(s).`);
    return { ...s, openQuestionIds, requirementIds: requirements.filter((r) => r.status === "ready").map((r) => r.id) };
  });
}

export async function announceWaiting(caseId: string, kind: "context" | "approval", token: string, message: string): Promise<void> {
  "use step";
  return guarded(caseId, "announceWaiting", async () => {
    const repo = getRepository();
    await syncCase(repo, caseId, "announceWaiting", message, { kind, token });
  });
}

export interface ContextAnswers {
  answers: { questionId: string; answer?: string; skip?: boolean }[];
  answeredBy: string;
}

/**
 * Record answers. A requirement becomes ready once none of its questions are open.
 * TODO: answers don't yet fill constraint values; decide how a `field` maps onto constraints.
 */
export async function applyContextAnswers(caseId: string, payload: ContextAnswers): Promise<CaseState & { stillOpen: number }> {
  "use step";
  return guarded(caseId, "applyContextAnswers", async () => {
    const repo = getRepository();
    const now = new Date().toISOString();
    const questions = await repo.list("questions", caseId);
    for (const a of payload.answers) {
      const q = questions.find((x) => x.id === a.questionId);
      if (!q || q.status !== "open") continue;
      const next = { ...q, status: a.skip ? ("skipped" as const) : ("answered" as const), answer: a.answer, answeredAt: now };
      await repo.upsert("questions", next);
      Object.assign(q, next);
      await audit(repo, {
        caseId,
        type: "context.question_answered",
        actor: { kind: "user", id: payload.answeredBy },
        stage: "PHOTO_ANALYZED",
        subject: { kind: "question", id: q.id },
        summary: a.skip ? "Skipped." : `Answered: ${a.answer ?? ""}`,
      });
    }
    for (const r of await repo.list("requirements", caseId)) {
      if (r.status !== "needs_context") continue;
      const open = questions.filter((q) => r.openQuestionIds.includes(q.id) && q.status === "open");
      if (open.length === 0) await repo.upsert("requirements", { ...r, status: "ready" });
    }
    const stillOpen = questions.filter((q) => q.status === "open").length;
    const s = await syncCase(repo, caseId, "applyContextAnswers", `${stillOpen} question(s) still open.`);
    return { ...s, stillOpen };
  });
}

/** Results per Exa search. Each is a candidate only if it's a single-product page. */
const SEARCH_RESULTS = 10;

/**
 * Exa product search for one requirement, restricted to the product's shops, with a structured
 * seller sheet per result (src/lib/product-fitness). Every sheet quote is verified verbatim
 * against the page; a page becomes a candidate only if it's a single-product page. Pages that
 * aren't are audited, never stored, so nothing is kept that the rules can't use.
 */
export async function researchProducts(caseId: string, requirementId: string): Promise<{ candidateIds: string[] }> {
  "use step";
  return guarded(caseId, "researchProducts", async () => {
    const repo = getRepository();
    const req = (await repo.list("requirements", caseId)).find((r) => r.id === requirementId);
    if (!req) throw new FatalError(`Requirement ${requirementId} not found`);
    const rule = ruleFor(req.ruleId);
    if (!rule) throw new FatalError(`Rule ${req.ruleId} no longer exists`);

    const started = Date.now();
    const includeDomains = SHOPS_FOR[req.productType as ProductType];
    const pages = await getProductSearchProvider().search({
      requirementId,
      query: rule.searchQuery,
      numResults: SEARCH_RESULTS,
      includeDomains,
      extract: { query: SHEET_QUERY, schema: SHEET_SCHEMA },
    });
    const candidateIds: string[] = [];
    const excluded: { url: string; reason: string }[] = [];
    const sheets: { candidateId: string; quotes: number; dropped: number }[] = [];
    for (const [i, p] of pages.entries()) {
      const parsed = p.text ? parseSheet(p.summary) : undefined;
      const sheet = parsed && verifySheet(parsed, p.text!, p.title ?? "");
      const check = productPageCheck({ url: p.url, sheet });
      if (!check.ok || !sheet) {
        excluded.push({ url: p.url, reason: check.ok ? "no product sheet" : check.reason });
        continue;
      }
      const candidateId = stableId("cand", requirementId, p.url);
      const source = { provider: "exa" as const, externalRef: p.requestId, at: p.retrievedAt };
      const evidence: ProductEvidence[] = [
        {
          // Verbatim seller quotes only (each checked against the page text), one per line.
          id: stableId("ev", candidateId, "seller_sheet"),
          caseId,
          candidateId,
          sourceUrl: p.url,
          kind: "structured_extraction",
          excerpt: sheetText(sheet),
          source,
        },
        { id: stableId("ev", candidateId, "page_text"), caseId, candidateId, sourceUrl: p.url, kind: "page_text", excerpt: p.text!, source },
        ...(p.highlights ?? []).map((h, j): ProductEvidence => ({ id: stableId("ev", candidateId, "highlight", j), caseId, candidateId, sourceUrl: p.url, kind: "highlight", excerpt: h, source })),
      ];
      for (const e of evidence) await repo.upsert("evidence", e);
      const candidate: ProductCandidate = {
        id: candidateId,
        caseId,
        requirementIds: [requirementId],
        title: sheet.productName || p.title || p.url,
        url: p.url,
        retailer: new URL(p.url).hostname,
        // Filled by decideProduct from GLiNER reads backed by verified seller quotes.
        attributes: [],
        evidenceIds: evidence.map((e) => e.id),
        discoveredBy: { provider: "exa", query: rule.searchQuery, externalRef: p.requestId, at: p.retrievedAt },
        searchRank: i + 1,
        status: "discovered",
      };
      await repo.upsert("candidates", candidate);
      candidateIds.push(candidateId);
      sheets.push({ candidateId, quotes: sheet.quotes, dropped: sheet.dropped.length });
    }
    await audit(repo, {
      caseId,
      type: "product.searched",
      actor: { kind: "tool", id: "exa" },
      stage: "REQUIREMENTS_DEFINED",
      subject: { kind: "requirement", id: requirementId },
      summary: `${pages.length} result(s) for "${rule.searchQuery}", ${candidateIds.length} single-product page(s).`,
      data: { urls: pages.map((p) => p.url), candidateIds, includeDomains, excluded, sheets },
      toolCall: { provider: "exa", operation: "search", ok: true, durationMs: Date.now() - started, externalRef: pages[0]?.requestId },
    });
    await syncCase(repo, caseId, "researchProducts", `${candidateIds.length} candidate(s) for ${req.productType}.`);
    return { candidateIds };
  });
}

/**
 * GLiNER2.5 Decide reads the product-fitness checklist over the candidate's verified seller sheet
 * (never the whole page: reviews and Q&A caused false readings). Each item sets an attribute only
 * when GLiNER says yes AND a verified seller quote backs it (decision 15). The rules engine then
 * decides from those attributes. The classification itself stays advisory: a red-flag read only
 * raises a concern, which can downgrade, never upgrade.
 */
export async function decideProduct(caseId: string, candidateId: string, requirementId: string): Promise<{ concern: boolean }> {
  "use step";
  return guarded(caseId, "decideProduct", async () => {
    const repo = getRepository();
    const req = (await repo.list("requirements", caseId)).find((r) => r.id === requirementId);
    if (!req) throw new FatalError(`Requirement ${requirementId} not found`);
    const candidate = (await repo.list("candidates", caseId)).find((c) => c.id === candidateId);
    if (!candidate) throw new FatalError(`Candidate ${candidateId} not found`);
    const sheet = (await repo.list("evidence", caseId)).find((e) => e.candidateId === candidateId && e.kind === "structured_extraction");
    const checklist = CHECKLISTS[req.productType as ProductType];
    if (!sheet || !checklist) return { concern: false }; // nothing to read; the rules engine will say unknown

    const started = Date.now();
    // A transient SIE error fails the step so it's retried; a permanent one is a missing read.
    const read = await readChecklist([{ key: candidateId, text: sheet.excerpt }], checklist.items, { rethrow: (e) => !isPermanentRequestError(e) });
    const pYes = Object.fromEntries(read.reads.map((r) => [r.itemId, maxYes(r)]));
    const { attributes, trace } = deriveAttributes(checklist, pYes, sheet.excerpt, sheet.id);
    await repo.upsert("candidates", { ...candidate, attributes });

    const redFlags = checklist.items.filter((it) => it.kind === "red_flag" && (pYes[it.id] ?? 0) >= 0.5);
    const answers: TypedAnswer[] = checklist.items.map((it) => {
      const p = pYes[it.id] ?? null;
      const probabilities: Record<string, number> = p === null ? {} : { yes: p, no: 1 - p };
      return { questionId: it.id, type: "noul", answer: p === null ? "unknown" : p >= 0.5 ? "yes" : "no", probabilities };
    });
    const k: ProductClassification = {
      id: stableId("cls", candidateId, requirementId, sheet.id, 0),
      caseId,
      candidateId,
      requirementId,
      answers,
      concern: redFlags.length > 0,
      evidenceIds: [sheet.id],
      source: { provider: "sie-decide", model: read.model, at: new Date().toISOString() },
    };
    await repo.upsert("classifications", k);
    const set = trace.filter((t) => t.result === "set");
    await audit(repo, {
      caseId,
      type: "product.classified",
      actor: { kind: "tool", id: "sie-decide" },
      stage: "PRODUCTS_RESEARCHED",
      subject: { kind: "candidate", id: candidateId },
      summary: `${set.length} attribute(s) backed by seller quotes${redFlags.length ? `; red flag: ${redFlags.map((r) => r.label).join(", ")}` : ""}.`,
      data: { classificationId: k.id, trace, failedRequests: read.failedRequests },
      toolCall: { provider: "sie-decide", operation: "extract", ok: read.failedRequests.length === 0, durationMs: Date.now() - started },
    });
    return { concern: k.concern };
  });
}

export async function evaluateProducts(caseId: string): Promise<CaseState & { eligible: number; needsVerification: number; rejected: number }> {
  "use step";
  return guarded(caseId, "evaluateProducts", async () => {
    const repo = getRepository();
    const [requirements, candidates, classifications] = await Promise.all([
      repo.list("requirements", caseId),
      repo.list("candidates", caseId),
      repo.list("classifications", caseId),
    ]);
    const counts = { eligible: 0, needsVerification: 0, rejected: 0 };
    for (const req of requirements.filter((r) => r.status === "ready")) {
      for (const cand of candidates.filter((c) => c.requirementIds.includes(req.id))) {
        const d = evaluateCandidate({
          id: stableId("dec", cand.id, req.id),
          requirement: req,
          candidate: cand,
          classifications,
        });
        await repo.upsert("decisions", d);
        await repo.upsert("candidates", {
          ...cand,
          status: d.outcome === "eligible" ? "evaluated" : d.outcome === "rejected" ? "rejected" : "needs_verification",
        });
        if (d.outcome === "eligible") counts.eligible++;
        else if (d.outcome === "rejected") counts.rejected++;
        else counts.needsVerification++;
        await audit(repo, {
          caseId,
          type: "decision.made",
          actor: { kind: "system", id: "rules-engine" },
          stage: "PRODUCTS_RESEARCHED",
          subject: { kind: "candidate", id: cand.id },
          summary: `${d.outcome} for ${req.productType} (${d.engineVersion}).`,
          data: { decisionId: d.id, ruleResults: d.ruleResults, preferredResults: d.preferredResults, score: d.score, notes: d.notes, classificationIds: d.classificationIds },
        });
      }
    }
    const s = await syncCase(
      repo,
      caseId,
      "evaluateProducts",
      `${counts.eligible} eligible, ${counts.needsVerification} need verification, ${counts.rejected} rejected.`,
    );
    return { ...s, ...counts };
  });
}

/** Prepare a purchase request from eligible decisions. Returns null when nothing is eligible. */
export async function preparePurchase(caseId: string): Promise<{ actionId: string } | null> {
  "use step";
  return guarded(caseId, "preparePurchase", async () => {
    const repo = getRepository();
    const existing = (await repo.list("actions", caseId)).find((a) => a.status === "awaiting_approval");
    if (existing) return { actionId: existing.id };
    const eligible = (await repo.list("decisions", caseId)).filter((d) => d.outcome === "eligible");
    if (eligible.length === 0) {
      await syncCase(repo, caseId, "preparePurchase", "No eligible products; nothing to prepare.");
      return null;
    }
    // One product per requirement: the best eligible one by preferred score, then search rank.
    const selected = selectForPurchase(eligible, await repo.list("candidates", caseId));
    const adapter = getShoppingAdapter(undefined, newId);
    const action = await adapter.prepare({ caseId, decisions: selected });
    await repo.upsert("actions", action);
    await audit(repo, {
      caseId,
      type: "action.prepared",
      actor: { kind: "tool", id: adapter.name },
      stage: "PRODUCTS_EVALUATED",
      subject: { kind: "action", id: action.id },
      summary: `${action.simulated ? "SIMULATED " : ""}${action.type} for ${action.candidateIds.length} product(s).`,
      data: { candidateIds: action.candidateIds, decisionIds: action.decisionIds, eligibleAlternatives: eligible.length - selected.length },
    });
    await audit(repo, {
      caseId,
      type: "action.approval_requested",
      actor: { kind: "system", id: "workflow" },
      stage: "PURCHASE_PREPARED",
      subject: { kind: "action", id: action.id },
      summary: "Waiting for explicit approval.",
    });
    return { actionId: action.id };
  });
}

export interface ApprovalPayload {
  actionId: string;
  approved: boolean;
  approvedBy: string;
}

export async function recordApprovalDecision(caseId: string, payload: ApprovalPayload): Promise<CaseState> {
  "use step";
  return guarded(caseId, "recordApprovalDecision", async () => {
    const repo = getRepository();
    const action = (await repo.list("actions", caseId)).find((a) => a.id === payload.actionId);
    if (!action) throw new FatalError(`Action ${payload.actionId} not found`);
    if (!payload.approved) {
      await repo.upsert("actions", { ...action, status: "declined", updatedAt: new Date().toISOString() });
      await audit(repo, {
        caseId,
        type: "action.declined",
        actor: { kind: "user", id: payload.approvedBy },
        stage: "APPROVAL_PENDING",
        subject: { kind: "action", id: action.id },
        summary: "Declined by the user.",
      });
      return syncCase(repo, caseId, "recordApprovalDecision", "Purchase declined.");
    }
    // approve() refuses unless the action is awaiting approval; executeApproved() refuses without the record.
    const approved = action.status === "approved" || action.status === "executed" ? action : approve(action, payload.approvedBy);
    await repo.upsert("actions", approved);
    await audit(repo, {
      caseId,
      type: "action.approved",
      actor: { kind: "user", id: payload.approvedBy },
      stage: "APPROVAL_PENDING",
      subject: { kind: "action", id: action.id },
      summary: "Explicitly approved by the user.",
    });
    const executed = approved.status === "executed" ? approved : await executeApproved(getShoppingAdapter(undefined, newId), approved);
    await repo.upsert("actions", executed);
    await audit(repo, {
      caseId,
      type: "action.executed",
      actor: { kind: "tool", id: executed.adapter },
      stage: "APPROVAL_PENDING",
      subject: { kind: "action", id: executed.id },
      summary: `${executed.simulated ? "SIMULATED: " : ""}executed (${executed.externalRef ?? "no receipt"}).`,
    });
    return syncCase(repo, caseId, "recordApprovalDecision", executed.simulated ? "Simulated purchase executed." : "Purchase executed.");
  });
}

/** Close the progress stream so SSE readers finish when the run does. */
export async function closeProgress(): Promise<void> {
  "use step";
  await getWritable<ProgressEvent>().close();
}

/**
 * End a run that stops before a purchase (no requirement rule matched, or nothing eligible).
 * The case must not stay `in_progress` after its run ends, so it is escalated to a person
 * with the reason, and the progress stream is closed.
 */
export async function concludeCase(caseId: string, outcome: "no_requirements" | "nothing_eligible", reason: string): Promise<CaseState> {
  "use step";
  return guarded(caseId, "concludeCase", async () => {
    const repo = getRepository();
    const c = await repo.getCase(caseId);
    if (!c) throw new FatalError(`Case ${caseId} not found`);
    if (c.status !== "escalated") {
      await audit(repo, {
        caseId,
        type: "case.status_changed",
        actor: { kind: "system", id: "workflow" },
        stage: c.stage,
        summary: `${c.status} → escalated (${outcome})`,
        data: { outcome, reason },
      });
    }
    await repo.updateCase(caseId, { status: "escalated", statusReason: reason });
    await emit({ caseId, step: "concludeCase", stage: c.stage, status: "escalated", message: reason });
    await getWritable<ProgressEvent>().close();
    return { stage: c.stage, status: "escalated" as const };
  });
}
