export interface CreationTemplateEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: "file" | "directory";
}
export interface CreationTemplateListing {
  rootPath: string;
  relativePath: string;
  entries: CreationTemplateEntry[];
}
export interface CreateTemplateItemsRequest {
  requestId: string;
  templateRoot: string;
  relativePaths: string[];
  destination: string;
  panelId: string | null;
  tabId: string | null;
}
