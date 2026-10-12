#!/usr/bin/env node
// Architecture gate for CI: fail the run when a measured Arcovia score drops
// below its threshold.
//
//   node scripts/arcovia-gate.mjs \
//     --target apps/canary-ui \
//     --report .arcovia/canary-ui/analysis.json \
//     --min-score 75
//
// Repeat the --target/--report/--min-score group once per analysed target.
//
// Why this script exists: Arcovia 0.2.2 has no --min-score/--fail-on option
// and exits 0 whatever the score, so analysis.json is the only reliable
// signal. Never read its console summary: that summary prints "Framework
// React" for every project that is not Next.js, including a project whose
// detected framework is "unknown". The gate also refuses to guess — a report
// that does not match the pinned schema, whose two duplicated score fields
// disagree, or whose analysis covered nothing is reported as a contract
// failure, never as a pass.
//
// Dependency-free by design, like scripts/stitch-docs.mjs.

import { readFile } from "node:fs/promises";

const SCHEMA = "https://schema.arcovia.dev/analysis/v1";
const SCHEMA_VERSION = "1.0.0";
const SCORE_TOLERANCE = 0.005;
const SEVERITY_RANK = { critical: 3, error: 2, info: 0, warning: 1 };
const SHOWN_FINDINGS = 10;
const EXIT_GATE_FAILED = 1;
const EXIT_USAGE = 2;

// pino is not available here: this script runs before `pnpm install`, and the
// CI job must stay independent from the workspace toolchain.
const out = (text) => process.stdout.write(`${text}\n`);
const fail = (text) => process.stderr.write(`${text}\n`);

class UsageError extends Error {}
class ContractError extends Error {}

function usage() {
  out(
    [
      "Usage:",
      "  node scripts/arcovia-gate.mjs --report <analysis.json> \\",
      "    --min-score <number> [--target <path>] [--report ...]",
      "",
      "Options:",
      "  --report <path>       analysis.json from `arcovia analyze --json`",
      "  --min-score <number>  lowest acceptable score.overall (0-100)",
      "  --target <path>       analysed path; label and fix hint in the output",
      "  --help                print this help",
      "",
      "Repeat the group once per analysed target.",
      `Exit codes: ${EXIT_GATE_FAILED} score below threshold or broken report`,
      `contract, ${EXIT_USAGE} usage error.`,
    ].join("\n")
  );
}

function takeValue(flag, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} needs a value`);
  }
  return value;
}

function hasValue(value) {
  return value !== undefined && value !== "";
}

function parseScore(flag, value) {
  const score = Number.parseFloat(takeValue(flag, value));
  if (!(Number.isFinite(score) && score >= 0 && score <= 100)) {
    throw new UsageError(`${flag} must be a number between 0 and 100`);
  }
  return score;
}

// Flags may be given in any order: a new target group starts at each --report.
// Values are parsed before the group is created, so a bad value never leaves a
// half-built group behind.
function parseArguments(argv) {
  const groups = [];
  let help = false;
  const attach = (key, value) => {
    const current = groups.at(-1);
    // A repeated --report or --target opens a new group; every other flag (or
    // the first occurrence of these two) refines the group being described.
    // That keeps every documented order equivalent:
    //   --target X --report r.json --min-score 75
    //   --report r.json --min-score 75 --target X
    const startNew =
      current === undefined ||
      (key === "report" && current.report !== undefined) ||
      (key === "label" && current.label !== undefined);
    const group = startNew
      ? { label: undefined, minScore: undefined, report: undefined }
      : current;
    if (startNew) {
      groups.push(group);
    }
    group[key] = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      help = true;
    } else if (flag === "--report" || flag === "--target") {
      const value = takeValue(flag, argv[index + 1]);
      attach(flag === "--report" ? "report" : "label", value);
      index += 1;
    } else if (flag === "--min-score") {
      attach("minScore", parseScore(flag, argv[index + 1]));
      index += 1;
    } else {
      throw new UsageError(`unknown option: ${flag}`);
    }
  }
  return { groups, help };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertContract(path, report) {
  if (!isPlainObject(report)) {
    throw new ContractError(`${path}: expected a JSON object`);
  }
  const { metadata, project, score, summary } = report;
  if (
    !(
      isPlainObject(metadata) &&
      isPlainObject(project) &&
      isPlainObject(score) &&
      isPlainObject(summary)
    )
  ) {
    throw new ContractError(
      `${path}: missing one of metadata, project, score, summary`
    );
  }
  if (metadata.schema !== SCHEMA || metadata.version !== SCHEMA_VERSION) {
    throw new ContractError(
      `${path}: expected schema ${SCHEMA} version ${SCHEMA_VERSION},` +
        ` got ${String(metadata.schema)} version ${String(metadata.version)}`
    );
  }
  const { overall } = score;
  const { overallScore } = summary;
  if (!(Number.isFinite(overall) && Number.isFinite(overallScore))) {
    throw new ContractError(
      `${path}: score.overall and summary.overallScore must both be numbers`
    );
  }
  if (Math.abs(overall - overallScore) > SCORE_TOLERANCE) {
    throw new ContractError(
      `${path}: score.overall (${overall}) disagrees with` +
        ` summary.overallScore (${overallScore})`
    );
  }
  const sourceFiles = Number(project.sourceFiles ?? 0);
  const modules = Number(project.modules ?? 0);
  if (!(sourceFiles > 0 && modules > 0)) {
    throw new ContractError(
      `${path}: covered ${sourceFiles} files and ${modules} modules;` +
        " an empty analysis cannot be gated"
    );
  }
  return {
    categoryScores: isPlainObject(score.categories) ? score.categories : {},
    findings: Array.isArray(report.findings) ? report.findings : [],
    grade: String(score.grade ?? "?"),
    overall,
    summary,
  };
}

async function loadReport(entry) {
  let raw;
  try {
    raw = await readFile(entry.report, "utf8");
  } catch (cause) {
    throw new ContractError(`${entry.report}: unreadable (${cause.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ContractError(`${entry.report}: invalid JSON (${cause.message})`);
  }
  const loaded = assertContract(entry.report, parsed);
  return { ...entry, ...loaded, label: entry.label ?? entry.report };
}

function severityOf(finding) {
  return isPlainObject(finding) ? String(finding.severity ?? "info") : "info";
}

function locationOf(finding) {
  const location = isPlainObject(finding) ? finding.location : undefined;
  const file = isPlainObject(location) ? String(location.file ?? "?") : "?";
  const line = isPlainObject(location) ? Number(location.line ?? 0) : 0;
  return line > 0 ? `${file}:${line}` : file;
}

function ruleOf(finding) {
  return isPlainObject(finding)
    ? String(finding.ruleId ?? "unknown")
    : "unknown";
}

function printFindings(target, result, needed) {
  const ranked = [...result.findings].sort((left, right) => {
    const bySeverity =
      (SEVERITY_RANK[severityOf(right)] ?? 0) -
      (SEVERITY_RANK[severityOf(left)] ?? 0);
    return bySeverity === 0
      ? locationOf(left).localeCompare(locationOf(right))
      : bySeverity;
  });
  out("");
  out(
    `${target} needs ${needed.toFixed(2)} more points` +
      ` (score ${result.overall.toFixed(2)}, minimum ${result.minScore.toFixed(2)}).`
  );
  if (ranked.length === 0) {
    out("  The report lists no finding to fix.");
  } else {
    out(
      `  Most severe findings (${Math.min(ranked.length, SHOWN_FINDINGS)} shown):`
    );
    for (const finding of ranked.slice(0, SHOWN_FINDINGS)) {
      out(
        `    ${severityOf(finding).padEnd(8)}` +
          ` ${ruleOf(finding).padEnd(24)} ${locationOf(finding)}`
      );
    }
    if (ranked.length > SHOWN_FINDINGS) {
      out(
        `    … ${ranked.length - SHOWN_FINDINGS} more, see the uploaded report.`
      );
    }
  }
}

function printFailureHint(target) {
  out("");
  out("Reproduce locally, then re-read the previous file:");
  out(`  npx arcovia@0.2.2 analyze ${target} --json --output .arcovia`);
  out(`  node scripts/arcovia-gate.mjs --target ${target} \\`);
  out("    --report .arcovia/analysis.json --min-score <threshold>");
}

function printTable(results) {
  const width = Math.max(...results.map((result) => result.label.length));
  out("");
  out("Architecture gate (arcovia)");
  for (const result of results) {
    const margin = result.overall - result.minScore;
    const verdict = margin >= 0 ? "PASS" : "FAIL";
    const signed = `${margin >= 0 ? "+" : ""}${margin.toFixed(2)}`;
    out(
      `  ${result.label.padEnd(width)}` +
        `  ${result.overall.toFixed(2).padStart(6)}` +
        `  ${result.grade.padEnd(2)}` +
        `  min ${result.minScore.toFixed(2).padStart(5)}` +
        `  ${verdict} (${signed})`
    );
  }
}

async function run() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      fail(`arcovia-gate: ${error.message}`);
      usage();
      return EXIT_USAGE;
    }
    throw error;
  }
  if (parsed.help) {
    usage();
    return 0;
  }
  if (parsed.groups.length === 0) {
    fail("arcovia-gate: at least one --report is required");
    usage();
    return EXIT_USAGE;
  }

  const results = [];
  try {
    for (const entry of parsed.groups) {
      const target = entry.label ?? entry.report ?? "a target group";
      if (!hasValue(entry.report)) {
        throw new UsageError(`${target} has no --report`);
      }
      if (!hasValue(entry.minScore)) {
        throw new UsageError(`${target} has no --min-score`);
      }
      results.push(await loadReport(entry));
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ContractError) {
      fail(`arcovia-gate: ${error.message}`);
      return EXIT_USAGE;
    }
    throw error;
  }

  printTable(results);

  const failures = results.filter((result) => result.overall < result.minScore);
  if (failures.length === 0) {
    return 0;
  }
  for (const failure of failures) {
    printFindings(failure.label, failure, failure.minScore - failure.overall);
  }
  printFailureHint(failures[0].label);
  return EXIT_GATE_FAILED;
}

process.exitCode = await run();
