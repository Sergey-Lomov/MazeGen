import { useEffect, useState } from "react";
import type React from "react";
import { Modal } from "./Modal";
import { FONT_NOTICES, LICENSE_TEXT_URLS, type FontLicense } from "./fontLicenses";
import { typography, spacing, ui, radius, font } from "../styles/theme";
import * as m from "~/paraglide/messages";

/** Licenses the bundled fonts use, in the order their full texts are listed. */
const LICENSES: FontLicense[] = ["ofl-1.1", "apache-2.0"];

const LICENSE_NAMES: Record<FontLicense, () => string> = {
  "ofl-1.1": () => m["font_licenses.license_ofl"](),
  "apache-2.0": () => m["font_licenses.license_apache"](),
};

/** Text of one license: `undefined` while loading, `null` when the download failed. */
type LicenseText = string | null | undefined;

/** Copyright notices and full license texts of the bundled MSDF fonts (GitHub issue #982), opened from
 *  the font picker. The texts are static assets fetched when the dialog opens, so they cost nothing
 *  until someone asks. Licenses of other dependencies are a separate matter (GitHub issue #990). */
export function FontLicensesModal({ onClose }: { onClose: () => void }) {
  const [texts, setTexts] = useState<Partial<Record<FontLicense, LicenseText>>>({});

  useEffect(() => {
    let alive = true;
    for (const license of LICENSES) {
      fetch(LICENSE_TEXT_URLS[license])
        .then((response) => (response.ok ? response.text() : null))
        .catch(() => null)
        .then((text) => { if (alive) setTexts((prev) => ({ ...prev, [license]: text })); });
    }
    return () => { alive = false; };
  }, []);

  return (
    <Modal title={m["font_licenses.title"]()} onClose={onClose}>
      <div style={styles.intro}>{m["font_licenses.intro"]()}</div>
      <div style={styles.list} data-testid="font-licenses-list">
        {FONT_NOTICES.map((notice) => (
          <div key={notice.id} style={styles.item} data-testid={`font-license-${notice.id}`}>
            <div style={typography.body}>{notice.name}</div>
            <div style={styles.caption}>{notice.copyright}</div>
            <div style={styles.caption}>{LICENSE_NAMES[notice.license]()}</div>
            <a href={notice.source} target="_blank" rel="noreferrer noopener" style={styles.link}>{notice.source}</a>
          </div>
        ))}
      </div>
      {LICENSES.map((license) => {
        const text = texts[license];
        return (
          <details key={license} style={styles.details}>
            <summary style={styles.summary}>{m["font_licenses.full_text"]({ license: LICENSE_NAMES[license]() })}</summary>
            {text === undefined && <div style={styles.caption}>{m["font_licenses.loading"]()}</div>}
            {text === null && <div style={styles.caption}>{m["font_licenses.load_failed"]()}</div>}
            {typeof text === "string" && <pre style={styles.text} data-testid={`license-text-${license}`}>{text}</pre>}
          </details>
        );
      })}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  intro: { ...typography.caption, lineHeight: 1.4 },
  list: { display: "flex", flexDirection: "column", gap: spacing.sectionGap },
  item: { display: "flex", flexDirection: "column", gap: spacing.elementsGap },
  caption: { ...typography.caption, lineHeight: 1.4 },
  link: { ...typography.caption, color: ui.text.secondary, wordBreak: "break-all" },
  details: { display: "flex", flexDirection: "column" },
  summary: { ...typography.body, cursor: "pointer" },
  text: {
    margin: `${spacing.itemGap}px 0 0`,
    padding: spacing.itemGap,
    maxHeight: 240,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    fontFamily: "monospace",
    fontSize: font.sm,
    color: ui.text.secondary,
    background: ui.bg.input,
    border: `1px solid ${ui.border.default}`,
    borderRadius: radius.sm,
  },
};
