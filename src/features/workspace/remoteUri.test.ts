import assert from "node:assert/strict";
import {
  createRemoteRootUri,
  planCopyOrMoveEntries,
  planCreateDirectory,
  planCreateFile,
  planDeleteEntries,
  planRenameEntry,
  resolveRemotePath
} from "./remoteUri";
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

const ftpProfile = {
  id: "remote-ftp",
  name: "Archive FTP",
  protocol: "ftp",
  host: "archive.example.test",
  port: 21,
  username: "ftp-user",
  rootPath: "/pub"
} satisfies RemoteProfile;

assertTest("createRemoteRootUri includes non-default remote ports", () => {
  assert.equal(createRemoteRootUri(sftpProfile), "sftp://cheng@127.0.0.1:6666/home/cheng");
});

assertTest("resolveRemotePath accepts default and explicit ports for the same profile", () => {
  const defaultPortProfile = {
    ...sftpProfile,
    port: 22
  } satisfies RemoteProfile;

  assert.equal(
    resolveRemotePath("sftp://cheng@127.0.0.1/home/cheng/report.txt", [defaultPortProfile])?.remotePath,
    "/home/cheng/report.txt"
  );
  assert.equal(
    resolveRemotePath("sftp://cheng@127.0.0.1:22/home/cheng/report.txt", [defaultPortProfile])?.remotePath,
    "/home/cheng/report.txt"
  );
});

assertTest("workspace operation planners route local and remote transfer directions", () => {
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

  assert.deepEqual(
    planCopyOrMoveEntries(
      "copy",
      ["sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"],
      "C:\\Users\\Admin\\Downloads",
      [sftpProfile]
    ),
    [
      {
        command: "download_remote_entries",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["/home/cheng/report.txt"],
            destination: "C:\\Users\\Admin\\Downloads"
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planCopyOrMoveEntries(
      "move",
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
      },
      {
        command: "delete_entries",
        args: {
          request: {
            sources: ["D:\\Projects\\Atlas\\README.md"]
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planCopyOrMoveEntries(
      "move",
      ["sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"],
      "C:\\Users\\Admin\\Downloads",
      [sftpProfile]
    ),
    [
      {
        command: "download_remote_entries",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["/home/cheng/report.txt"],
            destination: "C:\\Users\\Admin\\Downloads"
          }
        }
      },
      {
        command: "delete_remote_entries",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["/home/cheng/report.txt"],
            destination: null
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planCopyOrMoveEntries(
      "move",
      ["sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"],
      "sftp://cheng@127.0.0.1:6666/home/cheng/archive",
      [sftpProfile]
    ),
    [
      {
        command: "move_remote_entries",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["/home/cheng/report.txt"],
            destination: "/home/cheng/archive"
          }
        }
      }
    ]
  );
});

assertTest("workspace operation planners route cross-profile remote transfers through backend transfer command", () => {
  assert.deepEqual(
    planCopyOrMoveEntries(
      "copy",
      ["sftp://cheng@127.0.0.1:6666/home/cheng/report.txt"],
      "ftp://ftp-user@archive.example.test/pub/inbox",
      [sftpProfile, ftpProfile]
    ),
    [
      {
        command: "transfer_remote_entries",
        args: {
          request: {
            operation: "copy",
            sourceProfileId: "remote-test",
            sourcePassword: null,
            destinationProfileId: "remote-ftp",
            destinationPassword: null,
            sources: ["/home/cheng/report.txt"],
            destination: "/pub/inbox"
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planCopyOrMoveEntries(
      "move",
      ["ftp://ftp-user@archive.example.test/pub/outbox/data.csv"],
      "sftp://cheng@127.0.0.1:6666/home/cheng/inbox",
      [sftpProfile, ftpProfile]
    ),
    [
      {
        command: "transfer_remote_entries",
        args: {
          request: {
            operation: "move",
            sourceProfileId: "remote-ftp",
            sourcePassword: null,
            destinationProfileId: "remote-test",
            destinationPassword: null,
            sources: ["/pub/outbox/data.csv"],
            destination: "/home/cheng/inbox"
          }
        }
      }
    ]
  );
});

assertTest("workspace operation planners route remote mutations by profile id", () => {
  assert.deepEqual(
    planDeleteEntries(["sftp://cheng@127.0.0.1:6666/home/cheng/old"], [sftpProfile]),
    [
      {
        command: "delete_remote_entries",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            sources: ["/home/cheng/old"],
            destination: null
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planRenameEntry("sftp://cheng@127.0.0.1:6666/home/cheng/old.txt", "new.txt", [sftpProfile]),
    [
      {
        command: "rename_remote_entry",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            source: "/home/cheng/old.txt",
            newName: "new.txt"
          }
        }
      }
    ]
  );

  assert.deepEqual(
    planCreateDirectory("sftp://cheng@127.0.0.1:6666/home/cheng", "new-folder", [sftpProfile]),
    [
      {
        command: "create_remote_directory",
        args: {
          request: {
            profileId: "remote-test",
            password: null,
            parent: "/home/cheng",
            name: "new-folder"
          }
        }
      }
    ]
  );
});

assertTest("workspace operation planners create local files and reject remote file creation explicitly", () => {
  assert.deepEqual(planCreateFile("D:\\Projects", "notes.txt", [sftpProfile]), [
    {
      command: "create_file",
      args: {
        request: {
          parent: "D:\\Projects",
          name: "notes.txt"
        }
      }
    }
  ]);

  assert.throws(
    () => planCreateFile("sftp://cheng@127.0.0.1:6666/home/cheng", "notes.txt", [sftpProfile]),
    /Remote file creation is not supported yet/
  );
});
