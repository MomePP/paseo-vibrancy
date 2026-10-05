/**
 * The build's steps in run order, shared by the server (which reports
 * progress through them) and the client (which labels the progress bar).
 * Weights are measured seconds on Paseo 0.11.0-beta.4; the download is
 * network-bound, so its weight is a rough share rather than a measurement.
 */
export const BUILD_STEPS = [
  { id: "download", label: "Downloading Paseo", weight: 20 },
  { id: "extract", label: "Extracting", weight: 2 },
  { id: "verify", label: "Verifying signature", weight: 1 },
  { id: "copy", label: "Copying app", weight: 0.5 },
  { id: "patch", label: "Patching", weight: 2 },
  { id: "compile", label: "Compiling blur", weight: 0.7 },
  { id: "sign", label: "Signing", weight: 2 },
] as const;

export type BuildStepId = (typeof BUILD_STEPS)[number]["id"];

export type BuildProgress = {
  step: BuildStepId | "restart";
  fraction: number;
  detail: string | null;
};

/** The steps a build runs: from `download` when no pristine copy is cached, else from `copy`. */
export function buildPlan(needsDownload: boolean): BuildStepId[] {
  const first = BUILD_STEPS.findIndex((s) => s.id === (needsDownload ? "download" : "copy"));
  return BUILD_STEPS.slice(first).map((s) => s.id);
}

/**
 * Overall 0..1 progress for `plan` while `step` is `stepFraction` (0..1)
 * done: the weight of every planned step before it, plus its own share.
 */
export function overallFraction(plan: readonly BuildStepId[], step: BuildStepId, stepFraction: number): number {
  let done = 0;
  let total = 0;
  let reached = false;
  for (const s of BUILD_STEPS) {
    if (!plan.includes(s.id)) {
      continue;
    }
    total += s.weight;
    if (s.id === step) {
      reached = true;
      done += Math.min(Math.max(stepFraction, 0), 1) * s.weight;
    } else if (!reached) {
      done += s.weight;
    }
  }
  if (!reached) {
    throw new Error(`step ${step} is not in the build plan`);
  }
  return done / total;
}
