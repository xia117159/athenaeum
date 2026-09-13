import type { CreationTemplateEntry } from "../../app/templates";

export const templateKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();
const contains = (folder: CreationTemplateEntry, entry: CreationTemplateEntry) => folder.kind === "directory"
  && templateKey(entry.relativePath).startsWith(`${templateKey(folder.relativePath)}/`);

export function templateSelectionStatus(selected: CreationTemplateEntry[], entry: CreationTemplateEntry): "selected" | "included" | "none" {
  if (selected.some(item => templateKey(item.relativePath) === templateKey(entry.relativePath))) return "selected";
  return selected.some(item => contains(item, entry)) ? "included" : "none";
}
export function toggleTemplateSelection(selected: CreationTemplateEntry[], entry: CreationTemplateEntry) {
  const status = templateSelectionStatus(selected, entry);
  if (status === "included") return selected;
  if (status === "selected") return selected.filter(item => templateKey(item.relativePath) !== templateKey(entry.relativePath));
  return [...selected.filter(item => !contains(entry, item)), entry];
}
