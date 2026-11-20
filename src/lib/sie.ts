/**
 * Shared Superlinked SIE client. One instance per process.
 *
 * `SIEClient` reads SIE_BASE_URL itself; without it, an API key routes to SIE Serverless
 * (https://api.superlinked.com). Gemma 4 runs on the `sglang-cu130` bundle and
 * GLiNER2.5-Decide on `transformers5` if self-hosted, so a self-hosted setup may need two
 * base URLs. That's not supported yet; see docs/decisions.md.
 */

import { SIEClient } from "@superlinked/sie-sdk";
import { requireConfigured } from "./config";

let client: SIEClient | undefined;

export function getSieClient(): SIEClient {
  requireConfigured("sie-vision");
  client ??= new SIEClient(process.env.SIE_BASE_URL || undefined, { apiKey: process.env.SIE_API_KEY });
  return client;
}
