import { blockTypes, categories } from "../blocks/index.ts";
import { html } from "./dom.ts";
import { BLOCK_DRAG_TYPE } from "./editor.ts";

/** The block palette: click a block to add it, or drag it onto the diagram. */
export function renderPalette(host: HTMLElement, add: (kind: string) => void): void {
  host.replaceChildren(
    ...categories.map((category) =>
      html(
        "section",
        { class: "palette-group" },
        html("h2", { class: "palette-heading" }, category),
        ...blockTypes
          .filter((type) => type.category === category)
          .map((type) => {
            const button = html("button", { type: "button", class: "palette-item", draggable: "true", title: type.description }, type.label);
            button.addEventListener("click", () => add(type.kind));
            button.addEventListener("dragstart", (event) => {
              event.dataTransfer?.setData(BLOCK_DRAG_TYPE, type.kind);
              if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
            });
            return button;
          }),
      ),
    ),
  );
}
