import { useEffect } from "react";

// Set the browser tab title for the page that calls this. Each page passes
// its own short label; we suffix the brand so the user can always tell which
// tab is TeXAbr if several are open.
//
// Restores the previous title on unmount, so quick navigations through
// pages that don't set a title don't leave a stale label behind.

export function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => { document.title = prev; };
  }, [title]);
}
