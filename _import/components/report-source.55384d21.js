// Static exports embed only code-owned configuration, never executable evidence.
export const snapshot = typeof document === "undefined" ? null : JSON.parse(document.getElementById("dashboard-snapshot")?.textContent ?? "null");
// All presentation pages live in the same directory. Relative URLs keep the
// static package portable between a domain root and a GitHub repository path.
export const reportURL = snapshot ? "./data/report.json" : "/api/report";
export function pageURL(path) {
  if (!snapshot) return path;
  return path === "/" ? "./" : `.${path}.html`;
}
export function evidenceURL(ref) {
  if (snapshot) return ref.access === "snapshot" && /^evidence\/[A-Za-z0-9_./-]+$/.test(ref.path) && !ref.path.split("/").includes("..") ? `./${ref.path}` : null;
  return `/api/evidence?path=${encodeURIComponent(ref.path)}`;
}
