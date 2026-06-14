type JsdomLike = {
  window: Window & typeof globalThis;
};

type LegacyInputEventMethod = "attachEvent" | "detachEvent";

function installNoopLegacyInputEventMethod(target: object | null | undefined, method: LegacyInputEventMethod) {
  if (!target) {
    return;
  }
  Object.defineProperty(target, method, {
    configurable: true,
    value: () => undefined
  });
}

export function installLegacyInputEventPatch(dom: JsdomLike) {
  const targets = [
    dom.window.Element?.prototype,
    dom.window.HTMLElement?.prototype,
    dom.window.HTMLInputElement?.prototype,
    dom.window.HTMLTextAreaElement?.prototype,
    dom.window.document,
    dom.window
  ];

  for (const target of targets) {
    installNoopLegacyInputEventMethod(target, "attachEvent");
    installNoopLegacyInputEventMethod(target, "detachEvent");
  }
}

export function patchLegacyInputEventTarget(target: Element | null) {
  installNoopLegacyInputEventMethod(target, "attachEvent");
  installNoopLegacyInputEventMethod(target, "detachEvent");
}
