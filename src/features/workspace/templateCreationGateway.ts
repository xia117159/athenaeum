import type { CreateTemplateItemsRequest, CreationTemplateListing } from "../../app/templates";
import type { OperationTaskSnapshot } from "../../app/types";
import { invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

export function createTemplateGateway(runtime: { invoke?: WorkspaceInvoke; runtimeHost?: object | null } = {}) {
  return {
    list: (rootPath: string, relativePath = "") => invokeRequired<CreationTemplateListing>("list_creation_templates",
      { rootPath, relativePath }, async () => ({ rootPath, relativePath, entries: [] }), runtime.invoke, runtime.runtimeHost),
    create: (request: CreateTemplateItemsRequest) => invokeRequired<OperationTaskSnapshot>("create_template_items",
      { request }, async () => { throw new Error("请在桌面应用中创建模板副本"); }, runtime.invoke, runtime.runtimeHost),
    chooseRoot: () => invokeRequired<string | null>("choose_template_root", {}, async () => null, runtime.invoke, runtime.runtimeHost)
  };
}
export type TemplateGateway = ReturnType<typeof createTemplateGateway>;
