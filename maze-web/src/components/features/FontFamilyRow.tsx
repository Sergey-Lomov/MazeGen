import { useEffect, useState } from "react";
import type { LinkPath } from "../../store/parameterLinkSchema";
import { loadLabelFontFamily } from "../../pixi/renderers/labelFont";
import { LinkedSelectRow, LinkedTextFieldRow } from "./LinkedRows";
import * as m from "~/paraglide/messages";

let localFamiliesPromise: Promise<string[] | null> | null = null;

function loadLocalFamilies(): Promise<string[] | null> {
  if (!localFamiliesPromise) {
    const query = (window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
    localFamiliesPromise = query
      ? query().then((fonts) => [...new Set(fonts.map((font) => font.family.trim()).filter(Boolean))].sort()).catch(() => null)
      : Promise.resolve(null);
  }
  return localFamiliesPromise;
}

/** One link-aware font-family control for every canvas text style. Browsers that disclose local
 * fonts get the standard project select; the free-text fallback is only for unsupported/denied
 * Local Font Access API. */
export function FontFamilyRow<P extends LinkPath>({ value, onChange, linkTarget }: {
  value: string | undefined;
  onChange: (value: string) => void;
  linkTarget: P | null;
}) {
  const [families, setFamilies] = useState<string[] | null>(null);
  useEffect(() => {
    void loadLocalFamilies().then(setFamilies);
    // Project files retain the selected family name. Load it whenever this value arrives through
    // project restoration or a shared-style link, not only after a direct user selection.
    void loadLabelFontFamily(value ?? "");
  }, [value]);
  const commit = (family: string) => { void loadLabelFontFamily(family).then(() => onChange(family)); };
  if (families) {
    return <LinkedSelectRow label={m["image_export.label_font_family"]()} value={value ?? ""} options={[{ value: "", label: "Roboto" }, ...families.map((family) => ({ value: family, label: family }))]} onChange={commit} linkTarget={linkTarget} />;
  }
  return <LinkedTextFieldRow label={m["image_export.label_font_family"]()} value={value ?? ""} onChange={commit} linkTarget={linkTarget} />;
}
