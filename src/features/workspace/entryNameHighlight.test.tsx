import assert from "node:assert/strict";
import React, { type ReactNode } from "react";
import { renderEntryNameText } from "./entryNameHighlight";
import { compileQuickFilter } from "./quickFilterMatcher";
import type { QuickFilterMode, QuickFilterProgram } from "./quickFilterTypes";
import { assertTest } from "./workspaceControllerTestHarness";

/** 把渲染结果拍平成 [{ text, match }]，`match` 表示该片段落在 `mark.entry-name__match` 内。 */
function flatten(node: ReactNode, insideMatch = false): Array<{ text: string; match: boolean }> {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") return [{ text: String(node), match: insideMatch }];
  if (Array.isArray(node)) return node.flatMap((child) => flatten(child, insideMatch));
  if (React.isValidElement(node)) {
    const props = node.props as { className?: string; children?: ReactNode };
    return flatten(props.children, insideMatch || props.className === "entry-name__match");
  }
  throw new Error(`unexpected node: ${String(node)}`);
}

function program(text: string, mode: QuickFilterMode = "highlight"): QuickFilterProgram {
  const result = compileQuickFilter(text, "substring", mode);
  assert.ok(result.ok, `expected ${JSON.stringify(text)} to compile`);
  return result.program;
}

function joined(node: ReactNode): string {
  return flatten(node).map((part) => part.text).join("");
}

export const completion = (async () => {
  await assertTest("only highlight mode renders marks; other modes keep the raw name", async () => {
    for (const mode of ["include", "exclude"] as const) {
      const node = renderEntryNameText("my_project", program("project", mode));
      assert.equal(typeof node, "string", `${mode} must not change the DOM structure`);
      assert.equal(node, "my_project");
    }
  });

  await assertTest("a missing program or an empty filter keeps the raw name", async () => {
    assert.equal(renderEntryNameText("my_project", null), "my_project");
    assert.equal(renderEntryNameText("my_project", program("")), "my_project");
  });

  await assertTest("a non-matching name is returned as the original string", async () => {
    const node = renderEntryNameText("unrelated.txt", program("project"));
    assert.equal(typeof node, "string");
    assert.equal(node, "unrelated.txt");
  });

  await assertTest("a hit is wrapped in a mark while the surrounding text is preserved", async () => {
    assert.deepEqual(flatten(renderEntryNameText("my_project_dir", program("project"))), [
      { text: "my_", match: false },
      { text: "project", match: true },
      { text: "_dir", match: false }
    ]);
  });

  await assertTest("hits at the very start and the very end produce no empty fragments", async () => {
    assert.deepEqual(flatten(renderEntryNameText("project.txt", program("project"))), [
      { text: "project", match: true },
      { text: ".txt", match: false }
    ]);
    assert.deepEqual(flatten(renderEntryNameText("my_project", program("project"))), [
      { text: "my_", match: false },
      { text: "project", match: true }
    ]);
  });

  await assertTest("every hit is marked when a name matches more than once", async () => {
    const parts = flatten(renderEntryNameText("temp_project_project", program("project")));
    assert.deepEqual(parts, [
      { text: "temp_", match: false },
      { text: "project", match: true },
      { text: "_", match: false },
      { text: "project", match: true }
    ]);
    assert.equal(parts.filter((part) => part.match).length, 2);
  });

  await assertTest("pinyin initials highlight the matched Chinese run without altering the name", async () => {
    const node = renderEntryNameText("时间轴", program("sj"));
    assert.deepEqual(flatten(node), [
      { text: "时间", match: true },
      { text: "轴", match: false }
    ]);
    // 不变式：高亮只做切片，文本内容与顺序必须与原名完全一致。
    for (const name of ["时间轴", "my_project_dir", "project.txt", "a_project_project_b", "无命中名称"]) {
      assert.equal(joined(renderEntryNameText(name, program("project"))), name);
      assert.equal(joined(renderEntryNameText(name, program("sj"))), name);
    }
  });
})();
