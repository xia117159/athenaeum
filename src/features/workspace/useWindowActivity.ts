import { useEffect, useState } from "react";
import { createWindowActivityGateway, type WindowActivityGateway } from "./windowActivity";

let fallback: WindowActivityGateway | undefined;

/** Composition only: the gateway decides what counts as an active window (SPEC-018). */
export function useWindowActivity(gateway?: WindowActivityGateway) {
  const [active, setActive] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => (gateway ?? (fallback ??= createWindowActivityGateway())).subscribe(setActive), [gateway]);
  return active;
}
