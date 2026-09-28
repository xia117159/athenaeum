import { normalizeAutoDirectorySizePath } from "./directorySizeAutoPaths";
import { invokeRequired, type WorkspaceInvoke } from "./workspaceIpc";

const MAX_AUTO_DIRECTORY_SIZE_PATHS = 256;

/** Dedicated commands for the automatic size list; it is never part of a settings draft save (E7). */
export function createAutoDirectorySizeGateway(runtime: { invoke?: WorkspaceInvoke; runtimeHost?: object | null } = {}) {
  // Browser fallback: a local list with the same normalization, dedupe and limit as `auto_directory_size_paths::update`.
  let browserPaths: string[] = [];
  const browserUpdate = (input: string, add: boolean) => {
    const path = normalizeAutoDirectorySizePath(input);
    if (path === null) throw new Error("请输入有效的本地或网络文件夹绝对路径");
    const key = path.toLowerCase();
    if (!add) browserPaths = browserPaths.filter((saved) => saved.toLowerCase() !== key);
    else if (!browserPaths.some((saved) => saved.toLowerCase() === key)) {
      if (browserPaths.length >= MAX_AUTO_DIRECTORY_SIZE_PATHS) throw new Error("自动计算目录最多支持 256 项");
      browserPaths = [...browserPaths, path];
    }
    return [...browserPaths];
  };
  /**
   * The desktop broadcasts the saved list through `settings_changed`, the only source applied there: a command reply may
   * arrive after another window's newer broadcast (SAF-04). Only the browser fallback, which has no event, answers with it.
   */
  const update = async (command: string, path: string, add: boolean): Promise<string[] | undefined> => {
    let local: string[] | undefined;
    await invokeRequired<unknown>(command, { path }, () => (local = browserUpdate(path, add)), runtime.invoke, runtime.runtimeHost);
    return local;
  };
  return {
    add: (path: string) => update("add_auto_directory_size_path", path, true),
    remove: (path: string) => update("remove_auto_directory_size_path", path, false),
    choose: () => invokeRequired<string | null>("choose_directory_size_folder", {}, async () => null, runtime.invoke, runtime.runtimeHost)
  };
}
export type AutoDirectorySizeGateway = ReturnType<typeof createAutoDirectorySizeGateway>;
