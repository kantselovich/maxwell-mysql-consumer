import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { array, count, object, string } from "./evidence.ts";
import type { Evidence } from "./evidence.ts";

export const services = ["mysql84", "maxwell", "pubsub", "consumer", "mysql57"] as const;
export interface Presentation {
  tables: string[];
  containers: {service: string; name: string | null; image: string | null; state: string | null; dockerRestarts: number | null; source: string}[];
  events: {rowChanges: number; schemaChanges: number; otherEvents: number; invalidPayloads: number | null; source: string; basis: string} | null;
  issues: string[];
}

/** Optional presentation facts never determine the replication test verdict.
 * Container inspections are private inputs: only this explicit field whitelist
 * is published. In particular, no raw inspection becomes an evidence link.
 */
export async function presentation(e: Evidence): Promise<Presentation> {
  const details: Presentation = {containers: [], events: null, tables: [], issues: []};
  for (const service of services) {
    const file = `${service}-container.json`;
    try {
      const path = resolve(e.root, e.directory, file), stat = await lstat(path);
      const rel = relative(e.root, await realpath(path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024 || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Unsafe snapshot");
      const raw = JSON.parse(await readFile(path, "utf8"));
      if (!Array.isArray(raw) || raw.length !== 1) throw new Error("Invalid snapshot");
      const container = object(raw[0]);
      details.containers.push({service, name: string(container.Name), image: string(object(container.Config).Image), state: string(object(container.State).Status), dockerRestarts: count(container.RestartCount), source: e.ref(file).path});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") details.issues.push(`${service}: container snapshot unavailable or unsafe`);
    }
  }
  // Prefer observed payloads. Expected-event lists are a labeled fallback,
  // not receiver counters and not evidence of zero invalid input.
  const stateFile = e.cache.has("load-state.json") ? "load-state.json" : "recovery-state.json";
  const observations = object(e.cache.get("observations.json"));
  const observed = array(observations.payloads) ?? array(object(e.cache.get(stateFile)).payloads);
  const observedFile = array(observations.payloads) ? "observations.json" : stateFile;
  const expected = array(object(e.cache.get(stateFile)).expected);
  if (observed || expected) {
    details.events = {rowChanges: 0, schemaChanges: 0, otherEvents: 0, invalidPayloads: observed ? 0 : null,
      source: e.ref(observed ? observedFile : stateFile).path, basis: observed ? "Observed audit payloads" : "Expected workload events"};
    for (const value of observed ?? expected ?? []) {
      try {
        const event = observed ? JSON.parse(String(value)) : value;
        const type = string(object(event).type);
        const table = string(object(event).table), database = string(object(event).database);
        if (table) {
          const name = database ? `${database}.${table}` : `${table} (schema not recorded)`;
          if (!details.tables.includes(name)) details.tables.push(name);
        }
        if (["insert", "update", "delete"].includes(type ?? "")) details.events.rowChanges++;
        else if (/^(database|table)-(create|alter|drop)$/.test(type ?? "")) details.events.schemaChanges++;
        else details.events.otherEvents++;
      } catch { if (details.events.invalidPayloads !== null) details.events.invalidPayloads++; }
    }
  }
  return details;
}
