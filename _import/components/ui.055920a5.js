import {shown} from "./data.7cf45d44.js";

// Artifact strings only enter text nodes. Never interpolate evidence into HTML.
export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
export function add(parent, ...children) { parent.append(...children); return parent; }
export function heading(parent, title, description) { add(parent, el("h2", title)); if (description) add(parent, el("p", description, "muted")); }
export function badge(verdict) { return el("span", verdict, `badge ${verdict}`); }
export function table(headers, rows, label) {
  const wrap = el("div", undefined, "table-wrap"), t = el("table", undefined, headers.length > 2 ? "stack-narrow" : undefined);
  t.setAttribute("aria-label", label);
  add(t, add(el("thead"), add(el("tr"), ...headers.map(h => el("th", h)))));
  const body = el("tbody");
  for (const row of rows) add(body, add(el("tr"), ...row.map((value, i) => {
    const cell = add(el("td"), value instanceof Node ? value : document.createTextNode(shown(value)));
    cell.dataset.label = headers[i]; return cell;
  })));
  add(t, body); return add(wrap, t);
}
export function bars(title, values, unit) {
  const section = el("section", undefined, "chart");
  add(section, el("h3", title));
  const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 640 ${values.length * 36 + 34}`);
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${title}; values in the accompanying table`);
  const max = Math.max(1, ...values.map(d => d.value));
  values.forEach((d, i) => {
    const label = document.createElementNS(ns, "text"); label.setAttribute("x", "0"); label.setAttribute("y", String(i * 36 + 22)); label.textContent = d.label; svg.append(label);
    const rect = document.createElementNS(ns, "rect"); rect.setAttribute("x", "175"); rect.setAttribute("y", String(i * 36 + 5)); rect.setAttribute("width", String(d.value / max * 365)); rect.setAttribute("height", "23"); rect.setAttribute("rx", "3"); svg.append(rect);
    const number = document.createElementNS(ns, "text"); number.setAttribute("x", "552"); number.setAttribute("y", String(i * 36 + 22)); number.textContent = shown(d.value); svg.append(number);
  });
  add(section, svg, table(["Measurement", unit], values.map(d => [d.label, d.value]), title));
  return section;
}
