import { useEffect, useState, type RefObject } from "react";

// Fixed controls must follow Safari's visual viewport when its keyboard opens.
export function useWorkspaceViewport(composer: RefObject<HTMLDivElement | null>) {
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 700px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const changed = () => setMobile(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);
  useEffect(() => {
    const element = composer.current;
    if (!element) return;
    const measure = () =>
      document.documentElement.style.setProperty(
        "--composer-height",
        `${Math.ceil(element.getBoundingClientRect().height)}px`,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--composer-height");
    };
  }, [composer]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0,
      width = window.innerWidth,
      tallest = viewport?.height || window.innerHeight;
    const measure = () => {
      frame = 0;
      const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.05;
      const height = zoomed ? window.innerHeight : viewport?.height || window.innerHeight;
      const top = zoomed ? 0 : viewport?.offsetTop || 0;
      if (Math.abs(width - window.innerWidth) > 80) {
        width = window.innerWidth;
        tallest = height;
      }
      tallest = Math.max(tallest, height);
      const inset = zoomed ? 0 : Math.max(0, window.innerHeight - height - top);
      const focused = document.activeElement?.matches(
        "input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable=true]",
      );
      root.style.setProperty("--viewport-height", `${height}px`);
      root.style.setProperty("--viewport-top", `${top}px`);
      root.style.setProperty("--keyboard-inset", `${inset}px`);
      root.dataset.composerTyping = String(
        document.activeElement?.matches(".prompt-row textarea") || false,
      );
      root.dataset.keyboardOpen = String(
        !zoomed && !!focused && (inset > 120 || tallest - height > 120),
      );
    };
    const update = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      for (const name of ["--viewport-height", "--viewport-top", "--keyboard-inset"])
        root.style.removeProperty(name);
      delete root.dataset.keyboardOpen;
      delete root.dataset.composerTyping;
    };
  }, []);
  return mobile;
}
