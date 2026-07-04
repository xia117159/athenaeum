import assert from "node:assert/strict";
import {
  clearSystemIconCacheForTests,
  getSystemIconCacheKey,
  type SystemIconRequest
} from "./systemIconGateway";

function assertTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

assertTest("getSystemIconCacheKey shares file extension icons without overlay", () => {
  const request: SystemIconRequest = {
    kind: "file",
    path: "D:\\Projects\\alpha.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: false
  };
  assert.equal(getSystemIconCacheKey(request), "file:.txt:small");
});

assertTest("getSystemIconCacheKey uses path-specific key for local file overlay request", () => {
  const request: SystemIconRequest = {
    kind: "file",
    path: "D:\\Projects\\report.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: true
  };
  assert.equal(getSystemIconCacheKey(request), "file-overlay:d:\\projects\\report.txt:small");
});

assertTest("getSystemIconCacheKey uses path-specific key for local folder overlay request", () => {
  const request: SystemIconRequest = {
    kind: "folder",
    path: "D:\\GitRepo",
    extension: "",
    size: 16,
    imageList: "sys-small",
    includeOverlays: true
  };
  assert.equal(getSystemIconCacheKey(request), "folder-overlay:d:\\gitrepo:sys-small");
});

assertTest("getSystemIconCacheKey falls back to extension key for remote overlay request", () => {
  const request: SystemIconRequest = {
    kind: "file",
    path: "sftp://host/path/file.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: true
  };
  assert.equal(getSystemIconCacheKey(request), "file:.txt:small");
});

assertTest("getSystemIconCacheKey falls back to folder key when overlay requested without path", () => {
  const request: SystemIconRequest = {
    kind: "folder",
    path: undefined,
    extension: "",
    size: 16,
    imageList: "small",
    includeOverlays: true
  };
  assert.equal(getSystemIconCacheKey(request), "folder:small");
});

assertTest("getSystemIconCacheKey overlay request does not pollute extension cache", () => {
  const extensionRequest: SystemIconRequest = {
    kind: "file",
    path: "C:\\report.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: false
  };
  const overlayRequest: SystemIconRequest = {
    kind: "file",
    path: "C:\\report.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: true
  };

  const extensionKey = getSystemIconCacheKey(extensionRequest);
  const overlayKey = getSystemIconCacheKey(overlayRequest);

  assert.equal(extensionKey, "file:.txt:small");
  assert.equal(overlayKey, "file-overlay:c:\\report.txt:small");
  assert.notEqual(extensionKey, overlayKey);
});

assertTest("getSystemIconCacheKey distinguishes overlay requests by image list", () => {
  const smallRequest: SystemIconRequest = {
    kind: "file",
    path: "C:\\report.txt",
    extension: ".txt",
    size: 16,
    imageList: "small",
    includeOverlays: true
  };
  const largeRequest: SystemIconRequest = {
    kind: "file",
    path: "C:\\report.txt",
    extension: ".txt",
    size: 32,
    imageList: "large",
    includeOverlays: true
  };

  assert.equal(getSystemIconCacheKey(smallRequest), "file-overlay:c:\\report.txt:small");
  assert.equal(getSystemIconCacheKey(largeRequest), "file-overlay:c:\\report.txt:large");
  assert.notEqual(getSystemIconCacheKey(smallRequest), getSystemIconCacheKey(largeRequest));
});

assertTest("getSystemIconCacheKey distinguishes overlay requests by normalized path", () => {
  const upperRequest: SystemIconRequest = {
    kind: "folder",
    path: "D:\\GitRepo",
    extension: "",
    size: 16,
    imageList: "sys-small",
    includeOverlays: true
  };
  const lowerRequest: SystemIconRequest = {
    kind: "folder",
    path: "d:\\gitrepo",
    extension: "",
    size: 16,
    imageList: "sys-small",
    includeOverlays: true
  };

  assert.equal(getSystemIconCacheKey(upperRequest), getSystemIconCacheKey(lowerRequest));
});

clearSystemIconCacheForTests();
