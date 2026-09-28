import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { EvidenceRef } from "./model.ts";

export type JSONValue = null | string | number | boolean | JSONValue[] | { [key: string]: JSONValue };
export type ObjectValue = { [key: string]: JSONValue };
export const object = (v: JSONValue | undefined): ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
export const array = (v: JSONValue | undefined): JSONValue[] | null => Array.isArray(v) ? v : null;
export const string = (v: JSONValue | undefined): string | null => typeof v === "string" ? v : null;
export const number = (v: JSONValue | undefined): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
export const count = (v: JSONValue | undefined): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
export const strings = (v: JSONValue | undefined): string[] | null => Array.isArray(v) && v.every(x => typeof x === "string") ? v as string[] : null;
export const safeID = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v);

// Preserve numeric spelling/precision when comparing replay payloads, while
// allowing object key reordering. Numeric tokens cannot collide with JSON objects.
class NumericToken {
  source: string;
  constructor(source: string) { this.source = source; }
}
export function exactPayload(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("JSON numeric source tokens require the supported Node runtime");
    return new NumericToken(context.source);
  });
}

function parseJSON(text: string): JSONValue {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source) throw new Error("Missing numeric source token");
      return context.source; // e.g. UInt64 seeds remain exact strings, never rounded numbers.
    }
    return value;
  });
}

/** Never follows symlinks or copies raw logs/containers into the normalized report. */
export class Evidence {
  root: string; directory: string;
  issues: string[] = []; refs: EvidenceRef[] = [];
  cache = new Map<string, JSONValue | undefined>();
  constructor(root: string, directory: string) { this.root = root; this.directory = directory; }
  ref(file: string, pointer = ""): EvidenceRef {
    return { path: [this.directory === "." ? "" : this.directory, file].filter(Boolean).join("/"), pointer, access: "local-only" };
  }
  async link(file: string): Promise<void> {
    try {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) throw new Error("unsafe filename");
      const path = resolve(this.root, this.directory, file), info = await lstat(path);
      const resolved = relative(this.root, await realpath(path));
      if (!info.isFile() || info.isSymbolicLink() || resolved === ".." || resolved.startsWith(`..${sep}`)) throw new Error("unsafe evidence");
      if (!this.refs.some(ref => ref.path === this.ref(file).path)) this.refs.push(this.ref(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.issues.push(`${file}: unsafe evidence link`);
    }
  }
  async read(file: string, jsonl = false): Promise<JSONValue | undefined> {
    if (this.cache.has(file)) return this.cache.get(file);
    let value: JSONValue | undefined;
    try {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file)) throw new Error("unsafe filename");
      const path = resolve(this.root, this.directory, file);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("not a regular file");
      const resolved = relative(this.root, await realpath(path));
      if (resolved === ".." || resolved.startsWith(`..${sep}`)) throw new Error("outside artifact root");
      if (info.size > 64 * 1024 * 1024) throw new Error("exceeds 64 MiB evidence limit");
      const text = await readFile(path, "utf8");
      value = jsonl ? text.split("\n").filter(x => x.trim()).map(parseJSON) : parseJSON(text);
      this.refs.push(this.ref(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.issues.push(`${file}: unreadable, unsafe or invalid JSON`);
    }
    this.cache.set(file, value);
    return value;
  }
}
