import {el, add} from "./ui.055920a5.js";
import {snapshot} from "./report-source.55384d21.js";

export function configuration(files) {
  const section = el("div");
  if (snapshot) return section;
  const details = add(el("details", undefined, "compose-configuration"), el("summary", "View Docker Compose configuration"));
  add(details, el("p", "These current project files define the containers, images, startup checks, network connections and database storage. The test script supplies a unique run name, available local ports and the results folder when it starts Docker."));
  if (files.includes("compose.phase4.yaml")) add(details, el("p", "Recovery combines compose.yaml with compose.phase4.yaml. The second file enables controlled pause points in the consumer so the script can stop it at a specific point in a write."));
  const filesView = el("div"); add(details, filesView);
  let loaded = false;
  details.ontoggle = async () => {
    if (!details.open || loaded) return;
    loaded = true;
    filesView.replaceChildren();
    for (const path of files) {
      const url = `/api/source?path=${encodeURIComponent(path)}`;
      const link = el("a", `Open ${path}`); link.href = url; link.target = "_blank"; link.rel = "noopener";
      const contents = el("pre", "Loading configuration…"); contents.setAttribute("aria-label", path);
      add(filesView, el("h3", path), link, contents);
      try {
        const response = await fetch(url, {cache:"no-store"});
        if (!response.ok) throw new Error();
        contents.textContent = await response.text();
      } catch { contents.textContent = "Configuration could not be loaded. Open the file in the project to inspect it."; loaded = false; }
    }
  };
  return add(section, details);
}
