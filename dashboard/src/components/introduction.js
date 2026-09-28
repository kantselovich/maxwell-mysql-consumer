import mermaid from "../generated/mermaid.js";
import {navigation} from "./dashboard.js";

export async function introduction(root) {
  root.prepend(navigation("/"));
  mermaid.initialize({startOnLoad: false, securityLevel: "strict", deterministicIds: true, deterministicIDSeed: "poc", theme: "base", themeVariables: {fontFamily: "Arial", fontSize: "18px", primaryColor: "#eef5f2", primaryTextColor: "#172f35", primaryBorderColor: "#71978d", lineColor: "#577c73"}, flowchart: {htmlLabels: false, curve: "linear", rankSpacing: 30}});
  const direction = matchMedia("(max-width: 700px)").matches ? "TB" : "LR";
  const {svg} = await mermaid.render("poc-architecture", `flowchart ${direction}
    S[(Source MySQL 8.4)] -->|Binlog| M[Maxwell daemon]
    M -->|Change events| P[Pub/Sub emulator]
    P --> C[Swift MySQL consumer]
    C -->|Schema and data changes| T[(Target MySQL 5.7)]
    C -->|Failure diagnostics| D[Pub/Sub dead-letter queue - DLQ]
  `);
  // SVG is produced by strict Mermaid from this fixed, code-owned definition.
  // No artifact text or user data is interpolated into the diagram.
  root.querySelector("#architecture-diagram").innerHTML = svg;
  root.dataset.ready = "true";
}
