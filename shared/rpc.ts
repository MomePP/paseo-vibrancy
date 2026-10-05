import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

import { BUILD_STEPS } from "./build-progress.ts";
import { VibrancySettingsSchema } from "./vibrancy.ts";

export const ReleaseSchema = z.object({
  version: z.string(),
  zipUrl: z.string(),
  sha512: z.string(),
  size: z.number(),
});

export type Release = z.infer<typeof ReleaseSchema>;

export const BuildProgressSchema = z.object({
  step: z.enum([...BUILD_STEPS.map((s) => s.id), "restart"]),
  fraction: z.number(),
  detail: z.string().nullable(),
});

export const VibrancyStatusSchema = z.object({
  runningVersion: z.string().nullable(),
  runningVibrancyBuild: z.boolean(),
  builtFrom: z.string().nullable(),
  fingerprintMatches: z.boolean(),
  ghosttyOverrides: z.array(z.string()),
  latest: ReleaseSchema.nullable(),
  lastReport: z.array(z.string()),
  lastError: z.string().nullable(),
  building: z.boolean(),
  progress: BuildProgressSchema.nullable(),
});

export type VibrancyStatus = z.infer<typeof VibrancyStatusSchema>;

export const statusRpc = defineRpc({
  name: "vibrancy.status",
  input: z.object({}),
  output: VibrancyStatusSchema,
});

export const checkUpdateRpc = defineRpc({
  name: "vibrancy.check-update",
  input: z.object({}),
  output: z.object({
    release: ReleaseSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const buildRpc = defineRpc({
  name: "vibrancy.build",
  input: z.object({
    version: z.string().optional(),
    restart: z.boolean(),
  }),
  output: z.object({
    ok: z.boolean(),
    report: z.array(z.string()),
    error: z.string().nullable(),
  }),
});

export const getSettingsRpc = defineRpc({
  name: "vibrancy.get-settings",
  input: z.object({}),
  output: VibrancySettingsSchema,
});

export const setSettingsRpc = defineRpc({
  name: "vibrancy.set-settings",
  input: VibrancySettingsSchema,
  output: VibrancySettingsSchema,
});
