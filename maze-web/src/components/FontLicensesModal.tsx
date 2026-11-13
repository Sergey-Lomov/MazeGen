import { useEffect, useState } from "react";
import type React from "react";
import { Modal } from "./Modal";
import { LICENSE_TEXT_URLS, type FontLicense, type FontNotice } from "./fontLicenses";
import { typography, spacing, ui, radius, font } from "../styles/theme";
import * as m from "~/paraglide/messages";

const LICENSE_NAMES: Record<FontLicense, () => string> = {
  "ofl-1.1": () => m["font_licenses.license_ofl"](),
  "apache-2.0": () => m["font_licenses.license_apache"](),
};

/** Text of the license: `undefined` while loading, `null` when the download failed. */
type LicenseText = string | null | undefined;

/** Copyright notice and full license text of one bundled MSDF font (GitHub issues #982, #984), opened
 *  from the copyright icon in the font's row of the picker. The text is a static asset fetched when the
 *  dialog opens, so it costs nothing until someone asks. Licenses of other dependencies are a separate
 *  matter (GitHub issue #990). */
export function FontLicensesModal({ notice, onClose }: { notice: FontNotice; onClose: () => void }) {
  const [text, setText] = useState<LicenseText>(undefined);

  useEffect(() => {
    let alive = true;
    setText(undefined);
    fetch(LICENSE_TEXT_URLS[notice.license])
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null)
      .then((loaded) => { if (alive) setText(loaded); });
    return () => { alive = false; };
  }, [notice.license]);

  return (
    <Modal title={notice.name} onClose={onClose}>
      <div style={styles.intro}>{m["font_licenses.intro"]()}</div>
      <div style={styles.item} data-testid={`font-license-${notice.id}`}>
        <div style={styles.caption}>{notice.copyright}</div>
        <div style={styles.caption}>{LICENSE_NAMES[notice.license]()}</div>
        <a href={notice.source} target="_blank" rel="noreferrer noopener" style={styles.link}>{notice.source}</a>
      </div>
      <div style={typography.body}>{m["font_licenses.full_text"]({ license: LICENSE_NAMES[notice.license]() })}</div>
      {text === undefined && <div style={styles.caption}>{m["font_licenses.loading"]()}</div>}
      {text === null && <div style={styles.caption}>{m["font_licenses.load_failed"]()}</div>}
      {typeof text === "string" && <pre style={styles.text} data-testid="license-text">{text}</pre>}
    </Modal>
  );
}

const styles: Record<string, React.CSSProperties> = {
  intro: { ...typography.caption, lineHeight: 1.4 },
  item: { display: "flex", flexDirection: "column", gap: spacing.elementsGap },
  caption: { ...typography.caption, lineHeight: 1.4 },
  link: { ...typography.caption, color: ui.text.secondary, wordBreak: "break-all" },
  text: {
    margin: 0,
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
