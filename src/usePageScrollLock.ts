import { useEffect } from "react";
let locks = 0;
let previousOverflow = "";

// Navigation and nested dialogs can be open together; release only the last lock.
export function usePageScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (locks++ === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      if (--locks === 0) document.body.style.overflow = previousOverflow;
    };
  }, [active]);
}
