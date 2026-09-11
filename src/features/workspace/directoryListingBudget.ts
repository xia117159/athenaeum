import { useEffect, useReducer } from "react";

interface Budget { tryAcquire(): (() => void) | undefined; listen(listener: () => void): () => void }
const budgets = new WeakMap<object, Budget>();

/** No hidden queue or replacement workers: a blocked read keeps its slot. */
export function getDirectoryListingBudget(owner: object): Budget {
  const existing = budgets.get(owner);
  if (existing) return existing;
  let running = 0;
  const listeners = new Set<() => void>();
  const budget: Budget = {
    tryAcquire() {
      if (running >= 4) return undefined;
      running++;
      let released = false;
      return () => {
        if (released) return;
        released = true; running--;
        for (const listener of listeners) listener();
      };
    },
    listen(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  };
  budgets.set(owner, budget);
  return budget;
}

export function useDirectoryListingBudget(owner: object) {
  const budget = getDirectoryListingBudget(owner);
  const [version, wake] = useReducer((value: number) => value + 1, 0);
  useEffect(() => budget.listen(wake), [budget]);
  return { budget, version };
}
