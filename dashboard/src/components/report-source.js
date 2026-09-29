// Static exports embed only code-owned configuration, never executable evidence.
export const snapshot = typeof document === "undefined" ? null : JSON.parse(document.getElementById("dashboard-snapshot")?.textContent ?? "null");
export const reportURL = snapshot ? "/data/report.json" : "/api/report";
export function evidenceURL(ref) {
  if (snapshot) return ref.access === "snapshot" && /^evidence\/[A-Za-z0-9_./-]+$/.test(ref.path) && !ref.path.split("/").includes("..") ? `/${ref.path}` : null;
  return `/api/evidence?path=${encodeURIComponent(ref.path)}`;
}
