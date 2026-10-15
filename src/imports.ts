import { z } from "zod";
import type { PlausibleResponse } from "./plausible.js";

export const includeImportsSchema = z.boolean().optional().describe(
  "Request imported historical statistics (default false/native-only). Inspect imports coverage and warnings: some metric/filter/dimension combinations cannot include imports."
);

export const importCoverageSchema = z.object({
  requested: z.boolean(),
  imports_included: z.boolean().nullable(),
  imports_skip_reason: z.string().optional(),
  imports_warning: z.string().optional(),
  warnings: z.array(z.string()),
});

/** Omit the additive coverage field for unchanged calls with no upstream import metadata. */
export function buildImportCoverage(response: PlausibleResponse, requested?: boolean) {
  const meta = response.meta ?? {};
  if (requested === undefined && !["imports_included", "imports_skip_reason", "imports_warning"].some((key) => key in meta)) {
    return {};
  }
  const included = typeof meta.imports_included === "boolean" ? meta.imports_included : null;
  const reason = typeof meta.imports_skip_reason === "string" ? meta.imports_skip_reason : undefined;
  const warning = typeof meta.imports_warning === "string" ? meta.imports_warning : undefined;
  const warnings: string[] = [];
  if (warning) warnings.push(warning);
  if (requested && included === false) {
    warnings.push("Imported history was requested but not included. These are native-only results; missing imported history is not zero traffic.");
  } else if (requested && included === null) {
    warnings.push("Imported history was requested but upstream did not confirm inclusion. Historical coverage is unknown; do not treat missing history as zero traffic.");
  }
  return { imports: {
    requested: requested ?? false,
    imports_included: included,
    ...(reason !== undefined ? { imports_skip_reason: reason } : {}),
    ...(warning !== undefined ? { imports_warning: warning } : {}),
    warnings,
  } };
}
