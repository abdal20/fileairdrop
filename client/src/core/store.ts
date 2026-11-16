import { useSyncExternalStore } from "react";

export class Store<T> {
  private listeners = new Set<() => void>();

  constructor(private state: T) {}

  get = (): T => this.state;

  set(update: Partial<T> | ((prev: T) => T)) {
    this.state =
      typeof update === "function"
        ? (update as (prev: T) => T)(this.state)
        : { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
