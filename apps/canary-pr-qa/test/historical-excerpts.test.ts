import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * La preuve par cause, dans un artefact versionné.
 *
 * L'audit précédent a refusé deux versions du document de décision pour la même
 * raison : une citation présentée comme extraite d'un artefact, alors que son
 * run n'était pas dans le corpus, ou que le message n'était pas celui du run
 * cité. Ces extraits sont maintenant tirés des rapports de run et stockés ici,
 * avec leur identifiant ; le document doit citer un extrait de ce fichier, et un
 * extrait ne peut citer un run absent du corpus ou un code que ce run ne porte
 * pas.
 */
const dir = join(import.meta.dirname, "historical");
const corpus = JSON.parse(
  readFileSync(join(dir, "campaign-runs.json"), "utf8")
) as {
  run: string;
  batch: string;
  runDiagnostic?: string | null;
  scenarioCodes?: string[];
}[];
const excerpts = JSON.parse(
  readFileSync(join(dir, "excerpts.json"), "utf8")
) as {
  run: string;
  batch: string;
  code: string;
  message: string;
  messageSha256: string;
  quote: string;
}[];
const trialRuns = new Map<string, Set<string>>();
for (const name of [
  "prevention-trial.json",
  "reliability-pair.json",
  "controlled-campaign.json",
]) {
  const artifact = JSON.parse(readFileSync(join(dir, name), "utf8")) as {
    blocks?: { runs: { run: string; codes?: string[] }[] }[];
  };
  for (const block of artifact.blocks ?? []) {
    for (const run of block.runs) {
      trialRuns.set(run.run.slice(0, 8), new Set(run.codes ?? []));
    }
  }
}
const doc = readFileSync(
  join(import.meta.dirname, "../../../docs/pr-qa-reliability-decision.md"),
  "utf8"
);

describe("extraits de diagnostic, tirés des rapports de run", () => {
  it("chaque extrait appartient à un run du corpus, avec le code qu'il cite", () => {
    expect(excerpts.length).toBeGreaterThanOrEqual(3);
    for (const excerpt of excerpts) {
      const run = corpus.find((item) => item.run === excerpt.run);
      expect(run, excerpt.run).toBeDefined();
      const codes = new Set([
        ...(run?.scenarioCodes ?? []),
        ...(run?.runDiagnostic ? [run.runDiagnostic] : []),
      ]);
      expect(codes.has(excerpt.code), `${excerpt.run} ${excerpt.code}`).toBe(
        true
      );
      expect(excerpt.message.length).toBeGreaterThan(40);
      expect(excerpt.batch).toBe(run?.batch);
      // La citation publiée est un fragment littéral du message du run.
      expect(excerpt.message, excerpt.run).toContain(excerpt.quote);
      // L'empreinte rend le message recalculable sans le service, qui répond 401.
      expect(
        createHash("sha256").update(excerpt.message).digest("hex"),
        excerpt.run
      ).toBe(excerpt.messageSha256);
    }
  });

  it("les trois causes retenues portent chacune un extrait", () => {
    const causes = excerpts.map((item) => item.code);
    for (const code of [
      "TARGET_NOT_FOUND",
      "MARKER_ORDER_UNREACHABLE",
      "TRANSITION_NOT_OBSERVED",
    ]) {
      expect(causes, code).toContain(code);
    }
  });

  it("le document de décision cite ces extraits par leur run, jamais un run absent", () => {
    for (const excerpt of excerpts) {
      const short = excerpt.run.slice(0, 8);
      if (!doc.includes(short)) {
        continue;
      }
      // Le run est cité : sa citation doit être celle de l'extrait versionné.
      expect(doc, excerpt.run).toContain(excerpt.quote);
    }
  });
});

describe("attribution des identifiants dans le document", () => {
  /**
   * Un run cité dans une ligne de famille doit porter le code de cette ligne :
   * c'est la vérification que l'audit a faite à la main sur trois versions, et
   * qu'un identifiant recopié de travers suffisait à invalider.
   */
  it("chaque run cité dans une ligne de famille porte le code de la ligne", () => {
    const families = new Map(
      corpus.map((run) => [
        run.run,
        new Set([
          ...(run.scenarioCodes ?? []),
          ...(run.runDiagnostic ? [run.runDiagnostic] : []),
        ]),
      ])
    );
    const offenders: string[] = [];
    for (const line of doc.split("\n")) {
      const row = /^\| `([A-Z_]+)`/.exec(line);
      if (!row) {
        continue;
      }
      for (const short of line.matchAll(/`([0-9a-f]{8})`/g)) {
        const full = [...families.keys()].find((id) =>
          id.startsWith(short[1]!)
        );
        if (!full) {
          // Un run de campagne récente (essai, paire ou campagne entrelacée) est
          // une preuve versionnée au même titre que le corpus historique.
          const codes = trialRuns.get(short[1]!);
          if (!codes) {
            offenders.push(`${short[1]} absent des artefacts`);
          } else if (!codes.has(row[1]!)) {
            offenders.push(`${short[1]} ne porte pas ${row[1]}`);
          }
          continue;
        }
        if (!families.get(full)?.has(row[1]!)) {
          offenders.push(`${short[1]} ne porte pas ${row[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
