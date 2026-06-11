import assert from "node:assert/strict";
import {
  createRemoteRootUri,
  mapDirectoryListingToSnapshot,
  planCopyOrMoveEntries
} from "./workspaceGateway";
import type { RemoteProfile } from "../../app/types";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const sftpProfile = {
  id: "remote-test",
  name: "Test SFTP",
  protocol: "sftp",
  host: "127.0.0.1",
  port: 6666,
  username: "cheng",
  rootPath: "/home/cheng"
} satisfies RemoteProfile;

assertTest("workspaceGateway preserves compatibility exports for existing callers", () => {
  assert.equal(createRemoteRootUri(sftpProfile), "sftp://cheng@127.0.0.1:6666/home/cheng");

  const snapshot = mapDirectoryListingToSnapshot({
    location: {
      kind: "local",
      path: "C:\\Workspace"
    },
    entries: [],
    parent: "C:\\",
    canGoUp: true
  });
  assert.equal(snapshot.location.label, "Workspace");

  assert.deepEqual(
    planCopyOrMoveEntries(
      "copy",
      ["D:\\Projects\\Atlas\\README.md"],
      "sftp://cheng@127.0.0.1:6666/home/cheng/inbox",
      [sftpProfile]
    ),
    [
      {
        command: "upload_remote_files",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["D:\\Projects\\Atlas\\README.md"],
            destination: "/home/cheng/inbox"
          }
        }
      }
    ]
  );
});
