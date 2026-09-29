import {el, add, table} from "./ui.js";
import {evidence} from "./architecture.js";
import {parseDatabaseJSON, snapshots, rowSet, canonical, rowsMatch, columnsFor, cellText, isObject, schemaSet} from "./database-data.js";

const PAGE_SIZE = 25;
async function read(ref) {
  if (!ref) return {value: null};
  try {
    const response = await fetch(`/api/evidence?path=${encodeURIComponent(ref.path)}`);
    if (!response.ok) throw new Error("The saved file could not be read.");
    return {value: parseDatabaseJSON(await response.text())};
  } catch (error) { return {value: null, error: `${ref.path.split("/").pop()}: ${error.message}`}; }
}
function select(labelText, values) {
  const input = el("select"); input.setAttribute("aria-label", labelText);
  for (const [value, name] of values) { const option = el("option", name); option.value = value; add(input, option); }
  return {input, label: add(el("label", labelText), input)};
}
function pages(container, count, render) {
  let offset = 0;
  const body = el("div"), controls = el("div", undefined, "database-pagination");
  const previous = el("button", "Previous page"), next = el("button", "Next page"), range = el("span"); range.setAttribute("aria-live", "polite");
  const draw = () => {
    body.replaceChildren(); render(body, offset);
    range.textContent = count ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, count)} of ${count}` : "0 rows";
    previous.disabled = offset === 0; next.disabled = offset + PAGE_SIZE >= count;
  };
  previous.onclick = () => { offset -= PAGE_SIZE; draw(); };
  next.onclick = () => { offset += PAGE_SIZE; draw(); };
  add(controls, previous, range, next); add(container, body);
  if (count > PAGE_SIZE) add(container, controls);
  draw();
}
function schemas(parent, document) {
  const details = add(el("details"), el("summary", "Schema definitions"));
  const sides = el("div", undefined, "database-sides");
  for (const [key, title] of [["source", "Source · MySQL 8.4"], ["target", "Target · MySQL 5.7"]]) {
    const card = add(el("section", undefined, "database-side"), el("h3", title)), schema = schemaSet(document?.[key]);
    if (schema) {
      // The normalized schema preserves all recorded fields, including defaults,
      // collation, indexes and composite key order. It is not reconstructed DDL.
      add(card, el("pre", JSON.stringify(schema, null, 2)));
    } else add(card, el("p", "Schema definition unavailable in this capture."));
    add(sides, card);
  }
  if (schemaSet(document?.source) && schemaSet(document?.target)) add(details, el("p", canonical(document.source) === canonical(document.target) ? "Source and target schema definitions match." : "Source and target schema definitions differ."));
  add(parent, add(details, sides));
}

export function databaseView(run) {
  const section = el("section", undefined, "database-view"); section.setAttribute("aria-label", "Database contents");
  const groups = snapshots(run.evidence), plans = run.evidence.filter(ref => /\/(append|crud|schema-change)-plan\.json$/.test(ref.path));
  if (!groups.length && !plans.length) return section;
  add(section, el("h2", "Source and target data"), el("p", "Saved database snapshots from the selected test run. Choose a capture to inspect the rows and schema checked by the harness."));
  const details = add(el("details"), el("summary", "Explore database contents")), content = el("div"); add(section, add(details, content));
  let initialized = false;
  details.ontoggle = () => {
    if (!details.open || initialized) return;
    initialized = true;
    if (groups.length) {
      const {input, label} = select("Database snapshot", groups.map(group => [group.id, group.name]));
      const display = el("div"); add(content, label, display);
      let generation = 0;
      const render = async () => {
        const token = ++generation, group = groups.find(g => g.id === input.value);
        display.dataset.ready = "false"; display.replaceChildren(el("p", "Loading saved data…"));
        const [rows, schema] = await Promise.all([read(group.rows), read(group.schema)]);
        if (token !== generation) return;
        display.replaceChildren();
        for (const result of [rows, schema]) if (result.error) add(display, el("p", result.error, "notice"));
        const source = rowSet(rows.value?.source), target = rowSet(rows.value?.target);
        const match = rowsMatch(source, target);
        if (match !== null) add(display, el("p", match ? "Source and target rows match." : "Source and target rows differ.", match ? "result-summary" : "notice"));
        if (source || target) {
          add(display, el("p", "Rows are shown in saved order. The comparison includes every saved row and preserves duplicate counts.", "small"));
          if ([...(source ?? []), ...(target ?? [])].some(row => columnsFor([row], schema.value?.source).some(key => !Object.hasOwn(row, key)))) add(display, el("p", "Absent marks a field omitted from the saved row; the harness omits SQL NULL fields.", "small"));
        }
        pages(display, Math.max(source?.length ?? 0, target?.length ?? 0), (body, offset) => {
          const sides = el("div", undefined, "database-sides");
          for (const [key, title, values] of [["source", "Source · MySQL 8.4", source], ["target", "Target · MySQL 5.7", target]]) {
            const card = add(el("section", undefined, "database-side"), el("h3", title)); card.dataset.database = key;
            if (values === null) add(card, el("p", "Row comparison data unavailable in this capture."));
            else {
              add(card, el("p", `${values.length} saved rows`));
              const columns = columnsFor(values, schema.value?.[key]);
              if (values.length) add(card, table(columns, values.slice(offset, offset + PAGE_SIZE).map(row => columns.map(column => el("code", cellText(Object.hasOwn(row, column) ? row[column] : undefined)))), `${title} rows`));
              else add(card, el("p", "The table is empty."));
              if (values.length && offset >= values.length) add(card, el("p", "End of saved rows."));
            }
            add(sides, card);
          }
          add(body, sides);
        });
        if (group.schema) schemas(display, schema.value);
        const refs = el("div", undefined, "refs"); for (const ref of [group.rows, group.schema]) if (ref) add(refs, evidence(ref));
        add(display, refs); display.dataset.ready = "true";
      };
      input.onchange = () => void render(); void render();
    }
    if (plans.length) {
      const sql = add(el("details"), el("summary", "Source SQL plans"));
      add(sql, el("p", "Workload statements and bound parameters recorded before execution. The harness uses these plans to drive the test."));
      const {input, label} = select("SQL plan", plans.map(ref => [ref.path, ref.path.split("/").pop()]));
      const display = el("div"); add(sql, label, display); add(content, sql);
      let generation = 0, loaded = false;
      const render = async () => {
        const token = ++generation; display.dataset.ready = "false"; display.replaceChildren(el("p", "Loading SQL plan…"));
        const ref = plans.find(ref => ref.path === input.value), result = await read(ref);
        if (token !== generation) return;
        display.replaceChildren();
        const steps = result.value?.steps;
        if (!Array.isArray(steps) || !steps.every(step => isObject(step) && typeof step.sql === "string" && Array.isArray(step.bindings))) add(display, el("p", result.error ?? "The SQL plan could not be read.", "notice"));
        else {
          add(display, el("p", `${steps.length} planned statement${steps.length === 1 ? "" : "s"}`));
          pages(display, steps.length, (body, offset) => {
            for (const [i, step] of steps.slice(offset, offset + PAGE_SIZE).entries()) {
              add(body, el("h4", `Statement ${offset + i + 1}`), add(el("pre"), el("code", step.sql)));
              if (step.bindings.length) add(body, table(["Parameter", "Value"], step.bindings.map((value, index) => [String(index + 1), el("code", cellText(value))]), `Statement ${offset + i + 1} parameters`));
            }
          });
        }
        add(display, evidence(ref)); display.dataset.ready = "true";
      };
      input.onchange = () => void render();
      sql.ontoggle = () => { if (sql.open && !loaded) { loaded = true; void render(); } };
    }
  };
  return section;
}
