import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

type Hint = { target: HTMLElement; text: string; x: number; y: number };
const MARGIN = 8;

/** One tooltip for the whole settings surface, including disabled controls and table rows. */
export function SettingsTooltip({ scope, navigationKey }: { scope: RefObject<HTMLElement | null>; navigationKey: string }) {
  const [hint, setHint] = useState<Hint | null>(null);
  const [position, setPosition] = useState({ left: MARGIN, top: MARGIN });
  const tooltipRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const surface = scope.current;
    if (!surface) return;
    const doc = surface.ownerDocument;
    const view = doc.defaultView!;
    let timer: number | undefined;
    let pending: Hint | null = null;
    let describedControl: HTMLElement | null = null;
    let previousDescription: string | null = null;
    let pointerFocus = false;
    const hide = () => {
      if (timer !== undefined) view.clearTimeout(timer);
      timer = undefined;
      pending = null;
      if (describedControl) {
        if (previousDescription === null) describedControl.removeAttribute("aria-describedby");
        else describedControl.setAttribute("aria-describedby", previousDescription);
        describedControl = null;
      }
      setHint(null);
    };
    const targetFor = (target: EventTarget | null) => {
      const element = target instanceof view.Element ? target.closest<HTMLElement>("[data-settings-description]") : null;
      return element && surface.contains(element) && element.dataset.settingsDescription ? element : null;
    };
    const schedule = (target: HTMLElement, x: number, y: number, control?: HTMLElement) => {
      hide();
      pending = { target, text: target.dataset.settingsDescription!, x, y };
      timer = view.setTimeout(() => {
        timer = undefined;
        if (!pending || !pending.target.isConnected) return;
        if (control) {
          describedControl = control;
          previousDescription = control.getAttribute("aria-describedby");
          control.setAttribute("aria-describedby", [previousDescription, id].filter(Boolean).join(" "));
        }
        setHint({ ...pending });
      }, 500);
    };
    const over = (event: MouseEvent) => {
      const target = targetFor(event.target);
      if (target && target !== targetFor(event.relatedTarget)) schedule(target, event.clientX, event.clientY);
    };
    const out = (event: MouseEvent) => {
      if (targetFor(event.target) !== targetFor(event.relatedTarget)) hide();
    };
    const move = (event: MouseEvent) => {
      if (pending) { pending.x = event.clientX; pending.y = event.clientY; }
    };
    const focus = (event: FocusEvent) => {
      const target = targetFor(event.target);
      const control = event.target as HTMLElement;
      if (!target || pointerFocus) { pointerFocus = false; return; }
      const rect = control.getBoundingClientRect();
      schedule(target, rect.left, rect.bottom, control);
    };
    const pointerDown = () => { pointerFocus = true; hide(); };
    const keyDown = () => { pointerFocus = false; hide(); };
    surface.addEventListener("mouseover", over);
    surface.addEventListener("mouseout", out);
    surface.addEventListener("mousemove", move);
    surface.addEventListener("focusin", focus);
    surface.addEventListener("focusout", hide);
    doc.addEventListener("mousedown", pointerDown, true);
    doc.addEventListener("keydown", keyDown, true);
    doc.addEventListener("input", hide, true);
    doc.addEventListener("scroll", hide, true);
    view.addEventListener("blur", hide);
    view.addEventListener("resize", hide);
    hide();
    return () => {
      hide();
      surface.removeEventListener("mouseover", over);
      surface.removeEventListener("mouseout", out);
      surface.removeEventListener("mousemove", move);
      surface.removeEventListener("focusin", focus);
      surface.removeEventListener("focusout", hide);
      doc.removeEventListener("mousedown", pointerDown, true);
      doc.removeEventListener("keydown", keyDown, true);
      doc.removeEventListener("input", hide, true);
      doc.removeEventListener("scroll", hide, true);
      view.removeEventListener("blur", hide);
      view.removeEventListener("resize", hide);
    };
  }, [scope, navigationKey, id]);

  useLayoutEffect(() => {
    if (!hint || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const view = hint.target.ownerDocument.defaultView!;
    const left = Math.max(MARGIN, Math.min(hint.x + 12, view.innerWidth - rect.width - MARGIN));
    const below = hint.y + 18;
    const top = Math.max(MARGIN, Math.min(below + rect.height > view.innerHeight - MARGIN ? hint.y - rect.height - 12 : below,
      view.innerHeight - rect.height - MARGIN));
    setPosition({ left, top });
  }, [hint]);

  return hint ? createPortal(<div id={id} ref={tooltipRef} role="tooltip" className="settings-tooltip" style={position}>
    {hint.text}
  </div>, hint.target.ownerDocument.body) : null;
}
