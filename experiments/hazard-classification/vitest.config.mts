// Runs only the opt-in experiment runner (it makes real model calls). Not part of `aube run test`.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["experiments/hazard-classification/run.experiment.ts"], environment: "node", reporters: ["default"] },
});
