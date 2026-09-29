// Keep SQL integers and decimals exact, including numeric JSON from older captures.
export function parseDatabaseJSON(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== "number") return value;
    if (!context?.source) throw new Error("Exact numeric parsing requires a current browser.");
    return context.source;
  });
}
export const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
export function snapshots(refs) {
  const groups = new Map();
  for (const ref of refs) {
    const match = /^(.*\/)([^/]+)-(rows|schema)\.json$/.exec(ref.path);
    if (!match) continue;
    const key = match[1] + match[2];
    if (!groups.has(key)) groups.set(key, {id: key, name: match[2]});
    groups.get(key)[match[3]] = ref;
  }
  return [...groups.values()].sort((a, b) => Number(/readiness|markers/.test(a.name)) - Number(/readiness|markers/.test(b.name)) || Number(!a.schema || !a.rows) - Number(!b.schema || !b.rows) || a.name.localeCompare(b.name));
}
export function rowSet(value) {
  return Array.isArray(value) && value.every(row => isObject(row) && Object.values(row).every(v => v === null || ["string", "number", "boolean"].includes(typeof v))) ? value : null;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function rowsMatch(source, target) {
  if (!rowSet(source) || !rowSet(target)) return null;
  return canonical(source.map(canonical).sort()) === canonical(target.map(canonical).sort());
}
export function columnsFor(rows, schema) {
  return [...new Set([...(Array.isArray(schema?.columns) ? schema.columns.map(c => c?.name).filter(n => typeof n === "string") : []), ...rows.flatMap(row => Object.keys(row))])];
}
export function schemaSet(value) {
  return isObject(value) && typeof value.exists === "boolean" && Array.isArray(value.columns) && value.columns.every(c => isObject(c) && typeof c.name === "string" && typeof c.type === "string") && Array.isArray(value.indexes) ? value : null;
}
export function cellText(value) {
  if (value === undefined) return "Absent";
  if (value === null) return "NULL";
  if (value === "" || value === "NULL" || value === "Absent") return JSON.stringify(value);
  return String(value);
}
