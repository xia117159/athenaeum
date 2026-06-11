import assert from "node:assert/strict";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { WorkspaceTreeBranch } from "./WorkspaceTreeBranch";
import {
  clearSystemIconCacheForTests,
  setSystemIconResolverForTests,
  type SystemIconRequest
} from "./systemIconGateway";
import type { DirectoryNode } from "./types";

const { JSDOM } = require("jsdom") as {
  JSDOM: new (
    html?: string,
    options?: {
      url?: string;
    }
  ) => {
    window: Window & typeof globalThis;
  };
};

function assertTest(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`ok - ${name}`);
    })
    .catch((error) => {
      console.error(`not ok - ${name}`);
      throw error;
    });
}

function installDomEnvironment() {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url: "http://localhost"
  });

  globalThis.window = dom.window as typeof globalThis.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.Node = dom.window.Node;
  globalThis.Event = dom.window.Event;
  globalThis.MouseEvent = dom.window.MouseEvent;
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  return dom;
}

async function flushEffects() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const treeNode: DirectoryNode = {
  id: "D:\\",
  label: "Projects (D:)",
  path: "D:\\",
  kind: "drive",
  expandable: true,
  loaded: true,
  children: [
    {
      id: "D:\\Projects",
      label: "Projects",
      path: "D:\\Projects",
      kind: "folder",
      expandable: true,
      loaded: true,
      children: []
    }
  ]
};

const remoteTreeNode: DirectoryNode = {
  id: "remote-1",
  label: "Edge",
  path: "sftp://deploy@edge-01.internal/releases",
  kind: "remote-root",
  expandable: true,
  loaded: true,
  connectionState: "connected",
  children: [
    {
      id: "sftp://deploy@edge-01.internal/releases/current",
      label: "current",
      path: "sftp://deploy@edge-01.internal/releases/current",
      kind: "folder",
      expandable: true,
      loaded: false,
      children: []
    }
  ]
};

export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("test root container is missing");
  }

  const root = ReactDOM.createRoot(container);
  const resolvedIconRequests: SystemIconRequest[] = [];

  setSystemIconResolverForTests(async (request) => {
    resolvedIconRequests.push(request);
    return `data:image/mock;base64,${request.kind}`;
  });

  try {
    await assertTest("WorkspaceTreeBranch renders resolved system icons instead of tree kind text", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceTreeBranch, {
            node: treeNode,
            depth: 0,
            activePath: "D:\\Projects",
            expandedNodePaths: ["D:\\", "D:\\Projects"],
            onToggle: () => undefined,
            onNavigate: () => undefined
          })
        );
        await flushEffects();
      });

      const driveIcon = container.querySelector('.entry-icon[data-kind="drive"] img');
      const folderIcon = container.querySelector('.entry-icon[data-kind="folder"] img');
      const kindText = container.querySelector(".tree-node__kind");

      assert.ok(driveIcon);
      assert.ok(folderIcon);
      assert.equal(kindText, null);
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "drive" && request.imageList === "sys-small"),
        true
      );
      assert.equal(
        resolvedIconRequests.some((request) => request.kind === "folder" && request.imageList === "sys-small"),
        true
      );
    });

    await assertTest("WorkspaceTreeBranch uses icon-drawn plus and minus expand controls", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceTreeBranch, {
            node: treeNode,
            depth: 0,
            activePath: "D:\\Projects",
            expandedNodePaths: ["D:\\"],
            onToggle: () => undefined,
            onNavigate: () => undefined
          })
        );
        await flushEffects();
      });

      const toggle = container.querySelector(".tree-node__toggle");
      assert.ok(toggle);
      const expandedIcon = toggle.querySelector(".tree-node__toggle-icon");
      assert.ok(expandedIcon);
      assert.equal(expandedIcon.tagName.toLowerCase(), "svg");
      assert.equal(expandedIcon.classList.contains("lucide-minus"), true);
      assert.equal(toggle.textContent?.trim(), "");
      assert.equal(toggle.getAttribute("aria-expanded"), "true");

      await act(async () => {
        root.render(
          React.createElement(WorkspaceTreeBranch, {
            node: treeNode,
            depth: 0,
            activePath: "D:\\Projects",
            expandedNodePaths: [],
            onToggle: () => undefined,
            onNavigate: () => undefined
          })
        );
        await flushEffects();
      });

      const collapsedToggle = container.querySelector(".tree-node__toggle");
      assert.ok(collapsedToggle);
      const collapsedIcon = collapsedToggle.querySelector(".tree-node__toggle-icon");
      assert.ok(collapsedIcon);
      assert.equal(collapsedIcon.tagName.toLowerCase(), "svg");
      assert.equal(collapsedIcon.classList.contains("lucide-plus"), true);
      assert.equal(collapsedToggle.textContent?.trim(), "");
      assert.equal(collapsedToggle.getAttribute("aria-expanded"), "false");
    });

    await assertTest("WorkspaceTreeBranch renders remote roots and their loaded children", async () => {
      await act(async () => {
        root.render(
          React.createElement(WorkspaceTreeBranch, {
            node: remoteTreeNode,
            depth: 0,
            activePath: "sftp://deploy@edge-01.internal/releases/current",
            expandedNodePaths: ["sftp://deploy@edge-01.internal/releases"],
            onToggle: () => undefined,
            onNavigate: () => undefined
          })
        );
        await flushEffects();
      });

      assert.equal(container.textContent?.includes("Edge"), true);
      assert.equal(container.textContent?.includes("current"), true);
      assert.ok(container.querySelector('.entry-icon[data-kind="remote-root"]'));
      assert.ok(container.querySelector('.entry-icon[data-kind="folder"]'));
    });
  } finally {
    await act(async () => {
      root.unmount();
      await flushEffects();
    });
    setSystemIconResolverForTests(undefined);
    clearSystemIconCacheForTests();
    dom.window.close();
  }
})();
