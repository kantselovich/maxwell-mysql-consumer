export const shown = value => value === null || value === undefined ? "Unavailable" : typeof value === "number" ? value.toLocaleString("en-US", {maximumFractionDigits: 3}) : String(value);

export function orderedRuns(runs) {
  // Unknown legacy dates remain explicitly unknown; never invent timestamps from names.
  return [...runs].sort((a, b) => (Date.parse(b.startedAt.value) || 0) - (Date.parse(a.startedAt.value) || 0) || a.id.localeCompare(b.id));
}

export function comparisonWarnings(a, b) {
  const warnings = [];
  for (const [label, left, right] of [
    ["phase/scenario", [a.phase, a.scenarioIds, a.expectedOutcome], [b.phase, b.scenarioIds, b.expectedOutcome]],
    ["configuration (rows, pacing, seed)", a.configuration.value, b.configuration.value],
    ["versions", a.versions.value, b.versions.value],
    ["images / platform", a.images.value, b.images.value],
    ["code revision", a.code.value, b.code.value]
  ]) {
    if (left === null || right === null) warnings.push(`${label}: unavailable; comparability cannot be established.`);
    else if (JSON.stringify(left) !== JSON.stringify(right)) warnings.push(`${label}: differs; do not treat this as a like-for-like benchmark.`);
  }
  // Host resource limits and competing workloads are not recorded by the harness.
  warnings.push("Host environment is not fully recorded. These are observational results, not a controlled benchmark.");
  return warnings;
}

export function latencyBins(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)) throw new Error("Invalid latency samples");
  const width = samples.reduce((max, sample) => Math.max(max, sample), 0) / 8 || 1;
  const bins = Array.from({length: 8}, (_, i) => ({label: `${shown(i * width)}–${shown((i + 1) * width)} s`, value: 0}));
  for (const sample of samples) bins[Math.min(7, Math.floor(sample / width))].value++;
  return bins;
}

export function memorySamples(text) {
  let timestamp = null;
  const samples = [];
  for (const line of text.split("\n").filter(Boolean)) {
    if (/^\d{4}-\d\d-\d\dT/.test(line) && Number.isFinite(Date.parse(line))) { timestamp = line; continue; }
    const row = JSON.parse(line);
    const match = /^([\d.]+)(B|KiB|MiB|GiB)\s*\//.exec(row.MemUsage ?? "");
    const service = /-(consumer|maxwell)-\d+$/.exec(row.Name ?? "")?.[1];
    if (!timestamp || !match || !service) throw new Error("Unrecognized memory sample");
    const value = Number(match[1]) * ({B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024}[match[2]]);
    if (!Number.isFinite(value) || value < 0) throw new Error("Invalid memory sample");
    samples.push({timestamp, service, value});
  }
  if (!samples.length) throw new Error("No memory samples");
  return samples;
}
