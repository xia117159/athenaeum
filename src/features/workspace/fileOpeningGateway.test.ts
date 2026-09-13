import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createMockWorkspaceBootstrap } from "./mockData";
import { createRemoteRootUri } from "./remoteUri";
import { toBackendRemoteProfile } from "./workspaceBackendDtos";
import { cancelWorkspaceFileOpen, chooseAssociationProgram, fileOpenTarget, inspectAssociationPrograms, openWorkspaceFile, type FileOpeningRuntime } from "./fileOpeningGateway";
import type { FileOpenProgress } from "../../app/fileAssociations";

export const completion = (async () => {
  const profiles = createMockWorkspaceBootstrap("tauri").remoteProfiles;
  const profile = profiles[0];
  assert.ok(profile);
  const path = createRemoteRootUri(toBackendRemoteProfile(profile)) + "/中文 文件.MD";
  const target = fileOpenTarget(path, profiles);
  assert.deepEqual(target, {kind:"remote", profileId:profile.id, path:profile.rootPath.replace(/\/$/,"")+"/中文 文件.MD"});
  assert.throws(() => fileOpenTarget("sftp://missing@unknown/file.txt", profiles));
  assert.deepEqual(fileOpenTarget("D:\\文 档.txt", profiles), {kind:"local",path:"D:\\文 档.txt"});
  const calls: Array<{command:string;args:Record<string,unknown>}> = [];
  const progress: FileOpenProgress[] = [];
  let channelHandler!: (progress: FileOpenProgress) => void;
  const runtime: FileOpeningRuntime = {
    runtimeHost:{__TAURI_INTERNALS__:{}},
    createProgressChannel: handler => {channelHandler = handler; return "channel-for-this-request";},
    invoke: async <T>(command: string, args: Record<string,unknown>) => {
      calls.push({command,args});
      return (command === "open_file" ? {status:"opened",localPath:"C:\\temp\\file.md",associationId:"rule"}
        : command === "cancel_file_open" ? true : command === "choose_association_program" ? "C:\\editor.exe"
        : (args.paths as string[]).map(path => ({path,displayName:"编辑器",exists:true}))) as T;
    }
  };
  const request = {requestId:"open-1",target,associationId:"rule"};
  await openWorkspaceFile(request, event => progress.push(event), runtime);
  assert.deepEqual(calls[0], {command:"open_file",args:{request,onProgress:"channel-for-this-request"}});
  channelHandler({phase:"downloading",completedBytes:1024});
  assert.deepEqual(progress, [{phase:"downloading",completedBytes:1024}]);
  assert.equal(await cancelWorkspaceFileOpen("open-1",runtime), true);
  assert.deepEqual(calls[1], {command:"cancel_file_open",args:{requestId:"open-1"}});
  assert.equal(await chooseAssociationProgram(runtime),"C:\\editor.exe");
  assert.equal((await inspectAssociationPrograms(["C:\\editor.exe","C:\\editor.exe"],runtime)).length,1);
  await assert.rejects(openWorkspaceFile(request,()=>{}, {...runtime,invoke:async()=>{throw new Error("remote denied");}}),/remote denied/);
  await assert.rejects(chooseAssociationProgram({runtimeHost:null}),/桌面/);
  await assert.rejects(openWorkspaceFile(request, () => {}, {runtimeHost:null}), /桌面/, "browser rejection must precede the native Channel constructor");
  const permissions = readFileSync("src-tauri/permissions/default.toml", "utf8");
  const registration = readFileSync("src-tauri/src/lib.rs", "utf8").split("tauri::generate_handler![")[1];
  for (const command of ["open_file", "cancel_file_open", "inspect_association_programs", "choose_association_program"]) {
    assert.ok(permissions.includes(`commands.allow = ["${command}"]`), `permission for ${command}`);
    assert.ok(registration?.includes(`${command},`), `registration for ${command}`);
  }
  console.log("ok - typed local/remote open, scoped channel, cancel and native program IPC");
})();
