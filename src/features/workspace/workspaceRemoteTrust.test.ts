import assert from "node:assert/strict";
import {
  confirmAndTrustRemoteHostKey,
  createHostKeyConfirmationMessage,
  isUntrustedSftpHostKeyError,
  type RemoteTrustGateway
} from "./workspaceRemoteTrust";
import type { RemoteConnectionProfile } from "./types";

function assertTest(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

const sftpProfile: RemoteConnectionProfile = {
  id: "remote-wsl",
  name: "WSL",
  protocol: "sftp",
  host: "192.168.1.12",
  port: 6666,
  username: "cheng",
  rootPath: "/",
  authKind: "password",
  passiveMode: true,
  ignoreHostKey: false,
  connectTimeoutSecs: 10,
  commandTimeoutSecs: 20
};

function createGateway() {
  const calls = {
    lookups: [] as string[],
    trustedKeys: [] as Array<{ profileId: string; keyBase64: string }>
  };
  const gateway: RemoteTrustGateway = {
    async getRemoteHostKey(profileId) {
      calls.lookups.push(profileId);
      return {
        profileId,
        host: "192.168.1.12",
        port: 6666,
        algorithm: "ssh-ed25519",
        fingerprintSha256: "SHA256:test-fingerprint",
        keyBase64: "AAAA",
        knownHostsEntry: "[192.168.1.12]:6666 ssh-ed25519 AAAA",
        trustState: "unknown"
      };
    },
    async trustRemoteHostKey(request) {
      calls.trustedKeys.push({ profileId: request.profileId, keyBase64: request.keyBase64 });
      return {
        ...request,
        fingerprintSha256: "SHA256:test-fingerprint",
        knownHostsEntry: "[192.168.1.12]:6666 ssh-ed25519 AAAA",
        trustState: "trusted"
      };
    }
  };
  return { gateway, calls };
}

export const completion = (async () => {
  await assertTest("isUntrustedSftpHostKeyError recognizes the backend trust failure text only", () => {
    assert.equal(isUntrustedSftpHostKeyError("SFTP host key is not trusted yet; add host"), true);
    assert.equal(isUntrustedSftpHostKeyError("Connection refused"), false);
  });

  await assertTest("createHostKeyConfirmationMessage includes the auditable host key fields", () => {
    const message = createHostKeyConfirmationMessage({
      profileId: "remote-wsl",
      host: "192.168.1.12",
      port: 6666,
      algorithm: "ssh-ed25519",
      fingerprintSha256: "SHA256:test-fingerprint",
      keyBase64: "AAAA",
      knownHostsEntry: "[192.168.1.12]:6666 ssh-ed25519 AAAA",
      trustState: "unknown"
    });

    assert.equal(message.includes("192.168.1.12:6666"), true);
    assert.equal(message.includes("ssh-ed25519"), true);
    assert.equal(message.includes("SHA256:test-fingerprint"), true);
    assert.equal(message.includes("[192.168.1.12]:6666 ssh-ed25519 AAAA"), true);
  });

  await assertTest("confirmAndTrustRemoteHostKey ignores non-host-key errors", async () => {
    const { gateway, calls } = createGateway();

    const shouldRetry = await confirmAndTrustRemoteHostKey(
      gateway,
      [sftpProfile],
      "sftp://cheng@192.168.1.12:6666/",
      "Connection refused",
      () => true
    );

    assert.equal(shouldRetry, false);
    assert.deepEqual(calls.lookups, []);
    assert.deepEqual(calls.trustedKeys, []);
  });

  await assertTest("confirmAndTrustRemoteHostKey does not trust when the user cancels", async () => {
    const { gateway, calls } = createGateway();

    const shouldRetry = await confirmAndTrustRemoteHostKey(
      gateway,
      [sftpProfile],
      "sftp://cheng@192.168.1.12:6666/",
      "SFTP host key is not trusted yet",
      () => false
    );

    assert.equal(shouldRetry, false);
    assert.deepEqual(calls.lookups, ["remote-wsl"]);
    assert.deepEqual(calls.trustedKeys, []);
  });

  await assertTest("confirmAndTrustRemoteHostKey trusts the matching SFTP profile and requests a retry", async () => {
    const { gateway, calls } = createGateway();
    let confirmationMessage = "";

    const shouldRetry = await confirmAndTrustRemoteHostKey(
      gateway,
      [sftpProfile],
      "sftp://cheng@192.168.1.12:6666/",
      "SFTP host key is not trusted yet",
      (message) => {
        confirmationMessage = message;
        return true;
      }
    );

    assert.equal(shouldRetry, true);
    assert.deepEqual(calls.lookups, ["remote-wsl"]);
    assert.deepEqual(calls.trustedKeys, [{ profileId: "remote-wsl", keyBase64: "AAAA" }]);
    assert.equal(confirmationMessage.includes("SHA256:test-fingerprint"), true);
  });
})();
