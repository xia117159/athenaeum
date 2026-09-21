import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { act, useState } from "react";
import ReactDOM from "react-dom/client";
import { QuickFilterControls } from "./QuickFilterControls";
import { assertTest, flushEffects, installDomEnvironment } from "./workspaceControllerTestHarness";
import type { QuickFilterMode, QuickFilterSyntax } from "./quickFilterTypes";

/** 受控 input 必须走原型 setter，否则 React 的 value tracker 会吞掉 input 事件。 */
function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
  if (valueSetter) {
    valueSetter.call(input, value);
    return;
  }
  input.value = value;
}

/**
 * 底部状态栏快速过滤控件（§6.8 / B18–B21）。
 * 用有状态 harness 承载 mode/syntax/text，这样"左键循环"既能验证回调参数，
 * 也能验证按钮上的 data 属性真的随之更新。
 */
export const completion = (async () => {
  const dom = installDomEnvironment();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = ReactDOM.createRoot(container);
  const calls: string[] = [];

  function Harness({ error }: { error: string | null }) {
    const [mode, setMode] = useState<QuickFilterMode>("highlight");
    const [syntax, setSyntax] = useState<QuickFilterSyntax>("substring");
    const [text, setText] = useState("report");
    return (
      <QuickFilterControls text={text} error={error} mode={mode} syntax={syntax}
        onUpdateText={(value) => { calls.push(`text:${value}`); setText(value); }}
        onChangeMode={(next) => { calls.push(`mode:${next}`); setMode(next); }}
        onChangeSyntax={(next) => { calls.push(`syntax:${next}`); setSyntax(next); }}
        onClear={() => { calls.push("clear"); setText(""); }} />
    );
  }

  const modeButton = () => container.querySelector<HTMLButtonElement>("[data-quick-filter-mode]")!;
  const syntaxButton = () => container.querySelector<HTMLButtonElement>("[data-quick-filter-syntax]")!;
  const input = () => container.querySelector<HTMLInputElement>(".quick-filter__input")!;
  const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>(".quick-filter__menu [role='menuitemradio']")];
  const click = async (element: HTMLElement) => {
    await act(async () => { element.click(); await flushEffects(); });
  };
  /**
   * 真实鼠标点击：浏览器依次派发 pointerdown → pointerup → click。
   * 直接调用 `element.click()` 会跳过 pointerdown，从而掩盖"pointerdown 先关掉菜单、
   * 导致 click 落在已卸载节点上"这一类缺陷（用户实机复现的问题）。
   */
  const realClick = async (element: HTMLElement) => {
    await act(async () => {
      const pointerEvent = (type: string) =>
        typeof dom.window.PointerEvent === "function"
          ? new dom.window.PointerEvent(type, { bubbles: true, cancelable: true })
          : new dom.window.MouseEvent(type, { bubbles: true, cancelable: true });
      element.dispatchEvent(pointerEvent("pointerdown"));
      await flushEffects();
      element.dispatchEvent(pointerEvent("pointerup"));
      element.click();
      await flushEffects();
    });
  };
  const rightClick = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      await flushEffects();
    });
  };
  const render = async (error: string | null = null) => {
    await act(async () => { root.render(<Harness error={error} />); await flushEffects(); });
  };

  await assertTest("left click cycles both buttons through their fixed orders", async () => {
    await render();
    assert.equal(modeButton().dataset.quickFilterMode, "highlight");
    assert.equal(syntaxButton().dataset.quickFilterSyntax, "substring");

    for (const expected of ["include", "exclude", "highlight"]) {
      await click(modeButton());
      assert.equal(modeButton().dataset.quickFilterMode, expected);
    }
    assert.deepEqual(calls, ["mode:include", "mode:exclude", "mode:highlight"]);

    calls.length = 0;
    for (const expected of ["wildcard", "regex", "substring"]) {
      await click(syntaxButton());
      assert.equal(syntaxButton().dataset.quickFilterSyntax, expected);
    }
    assert.deepEqual(calls, ["syntax:wildcard", "syntax:regex", "syntax:substring"]);
  });

  await assertTest("right click opens a menu that marks the current value and applies a choice", async () => {
    await render();
    calls.length = 0;
    assert.deepEqual(menuItems(), [], "no menu before a right click");

    await rightClick(modeButton());
    const opened = menuItems();
    assert.deepEqual(opened.map((item) => item.textContent), ["高亮", "仅保留命中", "排除命中"]);
    assert.deepEqual(opened.map((item) => item.getAttribute("aria-checked")), ["true", "false", "false"]);

    await click(opened[2]);
    assert.deepEqual(calls, ["mode:exclude"]);
    assert.equal(modeButton().dataset.quickFilterMode, "exclude");
    assert.deepEqual(menuItems(), [], "choosing an item closes the menu");

    await rightClick(syntaxButton());
    const syntaxItems = menuItems();
    assert.deepEqual(syntaxItems.map((item) => item.textContent), ["子串", "通配符", "正则表达式"]);
    await click(syntaxItems[1]);
    assert.equal(syntaxButton().dataset.quickFilterSyntax, "wildcard");
    assert.deepEqual(menuItems(), []);
  });

  await assertTest("a real mouse click on a menu item applies the choice (user-reported regression)", async () => {
    // 用户实机复现：右键出菜单后，用鼠标点菜单项没有完成切换。
    // 根因是文档上的 pointerdown 监听先关掉了菜单，使得随后的 click 落在已卸载的节点上；
    // 因此必须模拟完整的 pointerdown → pointerup → click 序列，才能守住这条链路。
    await render();
    calls.length = 0;

    await rightClick(modeButton());
    const items = menuItems();
    assert.equal(items.length, 3, "precondition: the mode menu is open");
    items[2].focus();

    await realClick(items[2]);
    assert.deepEqual(calls, ["mode:exclude"],
      "a real click must reach the menu item before the surface is torn down");
    assert.equal(modeButton().dataset.quickFilterMode, "exclude");
    assert.deepEqual(menuItems(), [], "the menu closes after choosing");

    // 语法按钮走同一条链路。
    calls.length = 0;
    await rightClick(syntaxButton());
    const syntaxItems = menuItems();
    assert.equal(syntaxItems.length, 3, "precondition: the syntax menu is open");
    await realClick(syntaxItems[1]);
    assert.deepEqual(calls, ["syntax:wildcard"]);
    assert.equal(syntaxButton().dataset.quickFilterSyntax, "wildcard");
    assert.deepEqual(menuItems(), []);
  });

  await assertTest("a real pointerdown outside still dismisses the menu", async () => {
    // 修复"菜单内点击不再误关"之后，菜单外的点击必须仍然能关闭菜单。
    await render();
    await rightClick(modeButton());
    assert.equal(menuItems().length, 3, "precondition: the menu is open");

    await act(async () => {
      const target = container.querySelector<HTMLElement>(".quick-filter__input")!;
      target.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
      await flushEffects();
    });
    assert.deepEqual(menuItems(), [], "an outside pointerdown must dismiss the menu");
  });

  await assertTest("B14: a letter key while the filter menu is open never reaches the window", async () => {
    // 实机复现路径：右键出菜单后不点菜单项，直接按字母键 —— 焦点若仍停在触发按钮上，
    // 事件会绕过 handleMenuKeyDown 冒泡到 window，被键盘直输当成过滤文本写入（违反 B14:
    // "当前无菜单…打开时" 不直输）。ARIA menu-button 模式要求打开时把焦点移入菜单面。
    await render();
    calls.length = 0;
    await rightClick(modeButton());
    assert.equal(menuItems().length, 3, "precondition: the menu is open");
    assert.ok(menuItems().includes(document.activeElement as HTMLButtonElement),
      "focus must move into the menu when it opens");

    const seenAtWindow: string[] = [];
    const onWindowKeyDown = (event: KeyboardEvent) => { seenAtWindow.push(event.key); };
    window.addEventListener("keydown", onWindowKeyDown);
    try {
      await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true }));
        await flushEffects();
      });
    } finally {
      window.removeEventListener("keydown", onWindowKeyDown);
    }

    assert.deepEqual(seenAtWindow, [], "B14: the open menu must not leak keys to typeahead");
    assert.deepEqual(calls, [], "the filter text must not change");
  });

  await assertTest("the open menu focuses the current value and supports arrow navigation", async () => {
    // 焦点落到当前取值上，方向键导航才有确定的起点。
    // harness 的 mode 会跨用例保留，因此按 aria-checked 动态定位，不假设具体取值。
    await render();
    await rightClick(modeButton());
    const items = menuItems();
    const checkedIndex = items.findIndex((item) => item.getAttribute("aria-checked") === "true");
    assert.ok(checkedIndex >= 0, "precondition: exactly one item is marked as current");
    assert.equal(document.activeElement, items[checkedIndex], "the checked item receives focus");

    const expected = (checkedIndex + 1) % items.length;
    await act(async () => {
      items[checkedIndex].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      await flushEffects();
    });
    assert.equal(document.activeElement, items[expected], "ArrowDown moves to the next item");
  });

  await assertTest("B19: an invalid regex exposes all three error affordances and a red border", async () => {
    // §8:738 要求「非法正则时的红色边框 / aria-invalid / 提示文本」三条款齐备。
    // 修复前只实现了 aria-invalid：缺 aria-describedby、缺红色边框规则、警示节点是
    // role="img" 而非 B19 要求的 role="status" 文本，读屏器无从得知具体错误。
    await render("括号不匹配");
    const field = input();
    const warning = container.querySelector<HTMLElement>(".quick-filter__warning")!;
    assert.ok(warning, "precondition: a diagnostic renders a warning node");

    // 条款 1：aria-invalid。
    assert.equal(field.getAttribute("aria-invalid"), "true");

    // 条款 2：aria-describedby 必须指向真实存在的提示节点，且该节点给出具体错误信息。
    const describedBy = field.getAttribute("aria-describedby");
    assert.ok(describedBy, "the invalid input must point at its diagnostic via aria-describedby");
    const described = document.getElementById(describedBy);
    assert.equal(described, warning, "aria-describedby must resolve to the warning node");
    assert.match(warning.textContent ?? "", /括号不匹配/, "the diagnostic must carry the concrete message");
    assert.equal(warning.getAttribute("role"), "status",
      "B19 requires the diagnostic text to be a role=status live region");

    // 条款 3：红色边框必须由 CSS 规则提供（结构校验，不做像素级断言）。
    const css = readFileSync(join(process.cwd(), "src/features/workspace/workspace.quick-filter.css"), "utf8");
    assert.match(css, /\.quick-filter__input\[aria-invalid="true"\][^{]*\{[^}]*border[^}]*#d13438/i,
      "an invalid filter must be marked with a red border");
  });

  await assertTest("B19: the diagnostic wiring disappears when the expression becomes valid again", async () => {
    await render(null);
    assert.equal(input().getAttribute("aria-invalid"), "false");
    assert.equal(input().getAttribute("aria-describedby"), null);
    assert.equal(container.querySelector(".quick-filter__warning"), null);
    const describedBy = input().getAttribute("aria-describedby");
    assert.equal(describedBy, null, "a valid expression must not keep a dangling reference");
  });

  await assertTest("the mode and syntax menus close on Escape, Tab and ArrowLeft", async () => {
    // §8:738 明列「菜单 Escape 关闭」，修复前该键路径在本文件零覆盖。
    for (const key of ["Escape", "Tab", "ArrowLeft"]) {
      await render();
      await rightClick(modeButton());
      assert.equal(menuItems().length, 3, `precondition: the menu is open before ${key}`);
      await act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await flushEffects();
      });
      assert.deepEqual(menuItems(), [], `${key} must close the menu`);
    }
  });

  await assertTest("Enter on a focused menu item applies it and closes the menu", async () => {
    // 键盘可达性：焦点入菜单后必须能用 Enter 选中（与鼠标点击等价的路径）。
    await render();
    calls.length = 0;
    await rightClick(modeButton());
    const checkedIndex = menuItems().findIndex((item) => item.getAttribute("aria-checked") === "true");
    const expected = container.querySelector<HTMLButtonElement>("[data-quick-filter-mode]")!.dataset.quickFilterMode;
    const target = (checkedIndex + 1) % menuItems().length;
    // 先移动到目标项，再按 Enter。
    await act(async () => {
      for (let step = 0; step < target - checkedIndex + menuItems().length; step += 1) {
        (document.activeElement as HTMLElement).dispatchEvent(
          new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
        await flushEffects();
      }
      (document.activeElement as HTMLElement).dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await flushEffects();
    });
    const order = ["highlight", "include", "exclude"];
    const expectedMode = order[(order.indexOf(expected!) + target - checkedIndex + order.length) % order.length];
    assert.deepEqual(calls, [`mode:${expectedMode}`], "Enter must apply the focused item");
    assert.deepEqual(menuItems(), [], "the menu closes after Enter");
  });

  await assertTest("an invalid expression raises the warning affordance and marks the input invalid", async () => {
    await render(null);
    assert.equal(container.querySelector(".quick-filter__warning"), null);
    assert.equal(input().getAttribute("aria-invalid"), "false");

    await render("括号不匹配");
    const warning = container.querySelector<HTMLElement>(".quick-filter__warning")!;
    assert.ok(warning, "a diagnostic must surface a warning");
    assert.equal(warning.getAttribute("title"), "括号不匹配");
    assert.match(warning.textContent ?? "", /括号不匹配/, "B19: the diagnostic text carries the message");
    assert.equal(input().getAttribute("aria-invalid"), "true");
  });

  await assertTest("typing reports the raw text without interpreting it", async () => {
    await render();
    calls.length = 0;
    await act(async () => {
      setInputValue(input(), "p.*t");
      input().dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await flushEffects();
    });
    assert.deepEqual(calls, ["text:p.*t"]);
    assert.equal(input().value, "p.*t");
  });

  await assertTest("Escape inside the input clears the text, keeps focus, and never reaches the window", async () => {
    await render();
    calls.length = 0;
    input().focus();
    assert.equal(document.activeElement, input());

    const seenAtWindow: string[] = [];
    const onWindowKeyDown = (event: KeyboardEvent) => { seenAtWindow.push(event.key); };
    window.addEventListener("keydown", onWindowKeyDown);
    try {
      await act(async () => {
        input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await flushEffects();
      });
    } finally {
      window.removeEventListener("keydown", onWindowKeyDown);
    }

    assert.deepEqual(calls, ["clear"], "the input owns Escape and clears the text");
    assert.equal(document.activeElement, input(), "focus stays in the filter box");
    assert.deepEqual(seenAtWindow, [], "stopPropagation must keep it away from the list Esc semantics");
    assert.equal(input().value, "");

    // 文本已清空后再按 Esc 不应重复触发清空。
    calls.length = 0;
    await act(async () => {
      input().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await flushEffects();
    });
    assert.deepEqual(calls, []);

    await act(async () => { root.unmount(); await flushEffects(); });
    container.remove();
  });
})();
