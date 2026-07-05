import { useEffect } from "react";

export function useTransientScrollbars() {
  useEffect(() => {
    const hideTimers = new Map<HTMLElement, number>();
    const scrollKeys = new Set(["PageUp", "PageDown", "Home", "End", " "]);
    const scrollContainerSelector = [
      ".transfer-list-body",
      "[data-scroll-container]",
      ".xterm-viewport"
    ].join(",");
    const isScrollable = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      return (
        ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
          element.scrollHeight > element.clientHeight) ||
        ((overflowX === "auto" || overflowX === "scroll" || overflowX === "overlay") &&
          element.scrollWidth > element.clientWidth)
      );
    };
    const findScrollContainer = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return null;
      let element = target instanceof HTMLElement ? target : target.parentElement;
      const terminalViewport = element?.closest(".xterm")?.querySelector<HTMLElement>(".xterm-viewport");
      if (terminalViewport) {
        return terminalViewport;
      }
      const knownContainer = element?.closest<HTMLElement>(scrollContainerSelector);
      if (knownContainer) {
        return knownContainer;
      }
      while (element && element !== document.body) {
        if (isScrollable(element)) return element;
        element = element.parentElement;
      }
      return null;
    };
    const showScrollbar = (element: HTMLElement | null) => {
      if (!element) return;
      element.classList.add("scrollbar-active");
      const currentTimer = hideTimers.get(element);
      if (currentTimer) {
        window.clearTimeout(currentTimer);
      }
      const nextTimer = window.setTimeout(() => {
        element.classList.remove("scrollbar-active");
        hideTimers.delete(element);
      }, 720);
      hideTimers.set(element, nextTimer);
    };
    const showScrollbarForEvent = (event: Event) => {
      showScrollbar(findScrollContainer(event.target));
    };
    const showScrollbarForKey = (event: globalThis.KeyboardEvent) => {
      if (scrollKeys.has(event.key)) {
        showScrollbar(findScrollContainer(document.activeElement));
      }
    };

    window.addEventListener("scroll", showScrollbarForEvent, true);
    window.addEventListener("wheel", showScrollbarForEvent, { passive: true, capture: true });
    window.addEventListener("touchmove", showScrollbarForEvent, { passive: true, capture: true });
    window.addEventListener("keydown", showScrollbarForKey, true);

    return () => {
      hideTimers.forEach((timer, element) => {
        window.clearTimeout(timer);
        element.classList.remove("scrollbar-active");
      });
      hideTimers.clear();
      window.removeEventListener("scroll", showScrollbarForEvent, true);
      window.removeEventListener("wheel", showScrollbarForEvent, true);
      window.removeEventListener("touchmove", showScrollbarForEvent, true);
      window.removeEventListener("keydown", showScrollbarForKey, true);
    };
  }, []);
}
