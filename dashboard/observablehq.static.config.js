import {readFileSync} from "node:fs";
import common from "./observablehq.config.js";

// npm run build prepares the public-data export before Framework renders.
if (!process.env.STATIC_SNAPSHOT) throw new Error("Run npm run build to prepare the static dashboard data.");
const manifest = JSON.parse(readFileSync(process.env.STATIC_SNAPSHOT, "utf8"));
export default {
  ...common,
  output: "dist",
  base: "/maxwell-mysql-consumer/", // Framework uses this for a custom 404 page.
  preserveExtension: true,
  head: `<script id="dashboard-snapshot" type="application/json">${JSON.stringify(manifest).replaceAll("<", "\\u003c")}</script>`
};
