import { resolveRemotePath } from "./remoteUri";
import type { RemoteConnectionProfile } from "./types";
import type { WorkspaceGateway } from "./workspaceGateway";

export type RemoteTrustGateway = Pick<WorkspaceGateway, "getRemoteHostKey" | "trustRemoteHostKey">;

export type HostKeyConfirmation = (message: string) => boolean;

export function isUntrustedSftpHostKeyError(message: string) {
  return message.includes("SFTP host key is not trusted yet");
}

export function createHostKeyConfirmationMessage(info: Awaited<ReturnType<RemoteTrustGateway["getRemoteHostKey"]>>) {
  return [
    `是否信任此 SFTP 主机密钥？`,
    ``,
    `主机：${info.host}:${info.port}`,
    `算法：${info.algorithm}`,
    `指纹：${info.fingerprintSha256}`,
    ``,
    `known_hosts 条目：`,
    info.knownHostsEntry,
    ``,
    `仅在你确认这是目标服务器时选择“确定”。`
  ].join("\n");
}

function defaultConfirmHostKey(message: string) {
  return typeof window === "undefined" ? false : window.confirm(message);
}

export async function confirmAndTrustRemoteHostKey(
  workspaceGateway: RemoteTrustGateway,
  profiles: RemoteConnectionProfile[],
  path: string,
  message: string,
  confirmHostKey: HostKeyConfirmation = defaultConfirmHostKey
) {
  if (!isUntrustedSftpHostKeyError(message)) {
    return false;
  }

  const remote = resolveRemotePath(path, profiles);
  if (!remote || remote.profile.protocol !== "sftp") {
    return false;
  }

  const info = await workspaceGateway.getRemoteHostKey(remote.profile.id);
  if (!confirmHostKey(createHostKeyConfirmationMessage(info))) {
    return false;
  }

  await workspaceGateway.trustRemoteHostKey({
    profileId: info.profileId,
    host: info.host,
    port: info.port,
    algorithm: info.algorithm,
    keyBase64: info.keyBase64
  });
  return true;
}
