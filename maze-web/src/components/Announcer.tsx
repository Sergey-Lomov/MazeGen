import type React from "react";
import { useAnnouncerStore } from "../notifications/announcer";

/** Shared screen-reader announcer (GitHub issue #767): two visually hidden live regions fed by
 *  `announce()`. Toasts and field hints carry no live roles themselves, so each text is announced
 *  exactly once — errors assertively, notices and hints politely in arrival order. Mounted once in
 *  `App`. */
export function Announcer() {
  const entries = useAnnouncerStore((s) => s.entries);
  return (
    <>
      <div data-testid="announcer-assertive" role="alert" aria-live="assertive" aria-atomic="false" style={visuallyHidden}>
        {entries.filter((e) => e.politeness === "assertive").map((e) => <div key={e.id}>{e.text}</div>)}
      </div>
      <div data-testid="announcer-polite" role="status" aria-live="polite" aria-atomic="false" style={visuallyHidden}>
        {entries.filter((e) => e.politeness === "polite").map((e) => <div key={e.id}>{e.text}</div>)}
      </div>
    </>
  );
}

const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
};
