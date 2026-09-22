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

  await assertTest("B3: the menu is positioned inside the viewport when the trigger sits at the bottom edge", async () => {
    // 评审 B-3：底部状态栏贴近视口下沿，右键菜单若直接用 `rect.bottom` 作为 top，
    // 会有一大半落到视口之外 —— 出厂默认（折叠侧栏）实测菜单 863..935 对视口高 865，
    // 可见比例仅 0.028，溢出 70px 且不随窗口大小变化，body 又 overflow:hidden 无法滚动到。
    // jsdom 不做布局，因此这里手工铺设真实几何：
    const VIEWPORT_HEIGHT = 865;
    const MENU_HEIGHT = 72;
    const TRIGGER_BOTTOM = 863;
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    const innerWidthDescriptor = Object.getOwnPropertyDescriptor(window, "innerWidth");
    Object.defineProperty(window, "innerHeight", { value: VIEWPORT_HEIGHT, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });

    // 触发按钮贴近视口下沿。
    const triggerRect = {
      x: 20, y: TRIGGER_BOTTOM - 22, left: 20, right: 42, top: TRIGGER_BOTTOM - 22,
      bottom: TRIGGER_BOTTOM, width: 22, height: 22, toJSON: () => ({})
    } as DOMRect;
    const originalTriggerRect = modeButton().getBoundingClientRect;
    modeButton().getBoundingClientRect = () => triggerRect;

    try {
      await render();
      await rightClick(modeButton());
      const surface = document.querySelector<HTMLElement>(".quick-filter__menu");
      assert.ok(surface, "precondition: the menu is open");

      // 菜单面自身有真实高度（其他项都返回 0 会让断言失去鉴别力）。
      surface.getBoundingClientRect = () => ({
        x: 20, y: 0, left: 20, right: 140, top: 0, bottom: MENU_HEIGHT, width: 120, height: MENU_HEIGHT, toJSON: () => ({})
      } as DOMRect);
      // 打开后再量一次：实现必须在菜单挂载并量到尺寸之后重新定位。
      await act(async () => {
        window.dispatchEvent(new dom.window.Event("resize"));
        await flushEffects();
      });

      const top = Number.parseFloat(surface.style.top || "NaN");
      assert.ok(Number.isFinite(top), `the menu must carry an explicit numeric top, got ${JSON.stringify(surface.style.top)}`);

      // SR1 R-13：`top + height <= viewport - 8` 这种断言**只要发生夹取就成立**，
      // 无法区分"菜单正确贴着按钮下沿"与"被夹到屏幕顶端/压住触发器"。
      // 因此这里锁定的是实现契约本身：`positionMenu` 只做
      // `Math.max(8, Math.min(anchor.y, viewport.height - size.height - 8))`（menuInteraction.ts:22-33），
      // 即 top 必须是 anchor.y 在这个区间上的**投影**。
      const expectedTop = Math.max(8, Math.min(TRIGGER_BOTTOM, VIEWPORT_HEIGHT - MENU_HEIGHT - 8));
      assert.equal(top, expectedTop,
        `the menu top must be the clamped projection of the trigger's bottom edge: ` +
        `clamp(${TRIGGER_BOTTOM}) in [8, ${VIEWPORT_HEIGHT - MENU_HEIGHT - 8}] = ${expectedTop}, got ${top}`);
      // 由于 863 > 865-72-8=785，本次必然发生夹取 —— 断言必须能证明"确实夹了"，
      // 而不是恰好等于 anchor.y（否则等于没测到 B-3）。
      assert.ok(top < TRIGGER_BOTTOM,
        `this fixture must actually exercise the clamp: top=${top} must be strictly above the trigger bottom ${TRIGGER_BOTTOM}`);
      assert.ok(top + MENU_HEIGHT <= VIEWPORT_HEIGHT - 8,
        `the menu must fit inside the viewport: top=${top} + height=${MENU_HEIGHT} must be <= ${VIEWPORT_HEIGHT - 8}`);
      assert.ok(top >= 8, `the menu must not be pushed above the viewport: top=${top}`);
      // 水平方向同样要落在视口内（B-3 是四边问题，不只是纵向）。
      const left = Number.parseFloat(surface.style.left || "NaN");
      assert.ok(Number.isFinite(left) && left >= 8, `the menu must carry an explicit in-viewport left, got ${JSON.stringify(surface.style.left)}`);
    } finally {
      if (originalTriggerRect) modeButton().getBoundingClientRect = originalTriggerRect;
      if (innerHeightDescriptor) Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
      if (innerWidthDescriptor) Object.defineProperty(window, "innerWidth", innerWidthDescriptor);
    }
  });

  await assertTest("B3: the menu is re-measured and stays inside the viewport after a resize", async () => {
    // 窗口变小时菜单必须重新夹取；原实现从不调用 positionMenu，也就永远不重新量。
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const MENU_HEIGHT = 200;
    const triggerRect = {
      x: 20, y: 700, left: 20, right: 42, top: 700, bottom: 722, width: 22, height: 22, toJSON: () => ({})
    } as DOMRect;
    modeButton().getBoundingClientRect = () => triggerRect;
    try {
      await render();
      await rightClick(modeButton());
      const surface = document.querySelector<HTMLElement>(".quick-filter__menu")!;
      assert.ok(surface);
      surface.getBoundingClientRect = () => ({
        x: 20, y: 0, left: 20, right: 160, top: 0, bottom: MENU_HEIGHT, width: 140, height: MENU_HEIGHT, toJSON: () => ({})
      } as DOMRect);

      // 视口突然变矮：722 + 200 = 922 > 700 - 8，必须被夹回来。
      Object.defineProperty(window, "innerHeight", { value: 700, configurable: true });
      await act(async () => {
        window.dispatchEvent(new dom.window.Event("resize"));
        await flushEffects();
      });
      const top = Number.parseFloat(surface.style.top);
      assert.ok(top + MENU_HEIGHT <= 700 - 8,
        `after shrinking the viewport the menu must be re-clamped: top=${top} + ${MENU_HEIGHT} <= 692`);
    } finally {
      if (innerHeightDescriptor) Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
    }
  });

  await assertTest("B3: the menu follows the trigger when the pane scrolls (no resize involved)", async () => {
    // IR1 F-2：规格 §3.6 承诺"`ResizeObserver` + `resize`/**`scroll`** 重测"，但实现只接了前两者。
    // 触发按钮会**在不发生 resize 的情况下**移动：拖动分隔条改变面板宽度/滚动列表都会让
    // 底部状态栏里的按钮位移。兄弟菜单都接了滚动重测（`MenuPrimitives.tsx:42`、
    // `OpenWithMenu.tsx:57`、`TemplateCreationMenu.tsx:81`），快速过滤菜单当时是唯一漏的。
    const innerHeightDescriptor = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
    const MENU_HEIGHT = 100;
    // 触发按钮先在下沿附近，随后**因滚动而上移** 300px（视口高度不变）。
    // 起始位置选在**不被夹取**的区间内（`bottom + 100 <= 900 - 8`），
    // 这样 `before` 断言等于 `triggerBottom` 本身，测试隔离的正是"是否跟随滚动"。
    let triggerBottom = 600;
    const triggerRect = () => ({
      x: 20, y: triggerBottom - 22, left: 20, right: 42, top: triggerBottom - 22,
      bottom: triggerBottom, width: 22, height: 22, toJSON: () => ({})
    } as DOMRect);
    modeButton().getBoundingClientRect = () => triggerRect();
    try {
      await render();
      await rightClick(modeButton());
      const surface = document.querySelector<HTMLElement>(".quick-filter__menu")!;
      assert.ok(surface);
      surface.getBoundingClientRect = () => ({
        x: 20, y: 0, left: 20, right: 160, top: 0, bottom: MENU_HEIGHT, width: 140, height: MENU_HEIGHT, toJSON: () => ({})
      } as DOMRect);
      await act(async () => { await flushEffects(); });
      const beforeScroll = Number.parseFloat(surface.style.top);
      assert.equal(beforeScroll, 600, "precondition: the menu initially sits at the trigger's bottom edge (unclamped)");

      // 只派发 scroll（**不派发 resize**），模拟拖动分隔条/滚动导致的按钮位移。
      triggerBottom = 300;
      await act(async () => {
        document.dispatchEvent(new dom.window.Event("scroll"));
        await flushEffects();
      });
      const afterScroll = Number.parseFloat(surface.style.top);
      assert.equal(afterScroll, 300,
        `the menu must follow the trigger on scroll without a resize (got top=${afterScroll}, expected 300)`);
    } finally {
      if (innerHeightDescriptor) Object.defineProperty(window, "innerHeight", innerHeightDescriptor);
    }
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

  await assertTest("G8: the filter input exposes a title hint describing the active syntax", async () => {
    // 评审 G-8 / spec.md:218（B14）：输入框只有 aria-label，没有 title。
    // 鼠标用户悬停时看不到"当前是哪种语法、怎么用"的任何提示，
    // 而语法是会话全局状态（D4-R），恰恰最需要就地说明。
    await render(null);
    const field = input();
    assert.equal(field.getAttribute("aria-label"), "实时过滤", "the accessible name stays stable for screen readers");
    const hint = field.getAttribute("title");
    assert.ok(hint, "the input must carry a title hint");
    assert.match(hint!, /子串|通配符|正则/, "the hint must name the active syntax");
    assert.match(hint!, /\*/, "the hint must document the wildcard characters");
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
