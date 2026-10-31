import { nonRuntimeStatus } from "./approved-skips.js";
import { comparisonStatusNote } from "./baseline-diff.js";
import type { RunResult } from "./schema.js";

/** L'état et la description du commit status d'un run, publiés ensemble. */
export function commitStatus(result: RunResult): {
  state: "success" | "failure" | "error";
  description: string;
} {
  return {
    state: commitVerdict(result),
    description: statusDescription(result),
  };
}

/**
 * La description du statut de commit. La comparaison à la base y figure en tête
 * de ce que GitHub tronque (140 caractères) : un comportement modifié par la PR
 * ne peut pas passer inaperçu sous un statut vert. Un diff de documentation et
 * de tests seuls le dit plutôt qu'un « 0/0 scenarios » muet.
 */
function statusDescription(result: RunResult): string {
  const nonRuntime = nonRuntimeStatus(result);
  if (nonRuntime) {
    return nonRuntime;
  }
  const passed = result.scenarios.filter((s) => s.outcome === "passed").length;
  const note = comparisonStatusNote(result);
  const label = result.outcome === "blocked" ? "not proven" : result.outcome;
  const why = result.outcome === "blocked" ? unprovenReasons(result) : "";
  return `QA ${label}: ${passed}/${result.scenarios.length} scenarios${why ? ` · ${why}` : ""}${note ? ` · ${note}` : ""}`;
}

/**
 * Le verdict de commit est binaire : seul un run entièrement prouvé est vert,
 * et tout ce qui n'est pas prouvé est un échec — jamais un état neutre. Seuls
 * un diff de documentation et de tests seuls (rien d'exécutable à tester) et un
 * run périmé (préversion changée, à relancer) sortent de cette règle.
 */
function commitVerdict(result: RunResult): "success" | "failure" | "error" {
  if (result.outcome === "passed" || nonRuntimeStatus(result)) {
    return "success";
  }
  return result.outcome === "stale" ? "error" : "failure";
}

// Les codes qui ont laissé un scénario non prouvé, ou celui du run quand aucun
// scénario n'a tourné : l'échec dit pourquoi dans les 140 caractères de GitHub.
function unprovenReasons(result: RunResult): string {
  const codes = new Map<string, number>();
  for (const item of result.scenarios) {
    if (item.outcome !== "passed") {
      const code = item.diagnostic?.code ?? "UNPROVEN";
      codes.set(code, (codes.get(code) ?? 0) + 1);
    }
  }
  if (codes.size === 0) {
    return result.diagnostic?.code ?? "";
  }
  return [...codes].map(([code, count]) => `${count} ${code}`).join(", ");
}
