import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useMazeStore } from "../../store/mazeStore";
import type { ExportOverrideValue } from "../../store/zonesTypes";
import { Bubble } from "../Bubble";
import { cssColor } from "../EntityColorSwatch";
import { FlatIconButton } from "../FlatIconButton";
import { useOverrideTargets } from "../ZoneOverridesSection";
import { useLinkContext } from "./LinkContext";
import { typography, spacing, indent, muted, ui } from "../../styles/theme";
import * as m from "~/paraglide/messages";

/** The grey of the global context's bubble: not a zone, so it takes no zone colour. */
export const GLOBAL_CONTEXT_COLORS = { bg: ui.bg.hover, text: ui.text.secondary };

/** One context other than the one being edited that gives a parameter its own value: an override of zones and groups, or the whole maze. */
export interface OtherContextEntry {
  key: string;
  global: boolean;
  zoneIds: number[];
  groupIds: number[];
  value?: ExportOverrideValue;
  /** The context's own on or off state of the link driving the parameter, when it sets one. */
  linkEnabled?: boolean;
}

/** What the settings rows need to show the overrides of the other contexts under a parameter (GitHub issue #1040). */
export interface OtherContextOverrides {
  mode: "always" | "onRequest";
  entriesOf: (path: string) => OtherContextEntry[];
  /** Parameters whose list is open (only matters while `mode` is "onRequest"). */
  open: ReadonlySet<string>;
  toggle: (path: string) => void;
}

type Descriptor = { type: string; format: (v: unknown) => string };
const descriptorOf = (registry: object, path: string): Descriptor | undefined => (registry as Record<string, Descriptor | undefined>)[path];

function entriesFor(path: string | null, view: OtherContextOverrides | null | undefined): OtherContextEntry[] {
  return view && path !== null ? view.entriesOf(path) : [];
}

function formatValue(registry: object, path: string, value: ExportOverrideValue): string {
  const descriptor = descriptorOf(registry, path);
  if (descriptor) return descriptor.format(value);
  return typeof value === "boolean" ? m[value ? "image_export.zone_overrides.value_on" : "image_export.zone_overrides.value_off"]() : String(value);
}

/** The button of a parameter's row that opens or closes its list of other contexts' values; only for the "on request" display
 *  and a parameter that has any. */
export function OtherContextToggle({ linkTarget }: { linkTarget: string | null }) {
  const view = useLinkContext<string>().otherOverrides;
  if (!view || view.mode !== "onRequest" || linkTarget === null || entriesFor(linkTarget, view).length === 0) return null;
  const open = view.open.has(linkTarget);
  return (
    <FlatIconButton title={m[open ? "image_export.zone_overrides.display_hide" : "image_export.zone_overrides.display_show"]()} onClick={() => view.toggle(linkTarget)}>
      {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
    </FlatIconButton>
  );
}

/** A settings row with the values of the other contexts under it: embedded rows, or the list the row's button opens. */
export function WithOtherContextOverrides({ linkTarget, children }: { linkTarget: string | null; children: React.ReactNode }) {
  const view = useLinkContext<string>().otherOverrides;
  const entries = entriesFor(linkTarget, view);
  const shown = !!view && linkTarget !== null && entries.length > 0 && (view.mode === "always" || view.open.has(linkTarget));
  if (!shown) return <>{children}</>;
  return (
    <div style={styles.wrap}>
      {children}
      <OtherContextRows path={linkTarget} entries={entries} />
    </div>
  );
}

function OtherContextRows({ path, entries }: { path: string; entries: OtherContextEntry[] }) {
  const { targets, showTarget, hover } = useOverrideTargets();
  const setContext = useMazeStore((s) => s.setExportOverrideContext);
  const { registry } = useLinkContext<string>();
  const isColor = descriptorOf(registry, path)?.type === "color";
  return (
    <div style={styles.list}>
      {entries.map((entry) => (
        <div key={entry.key} style={styles.row} data-testid="export-other-context-override">
          <div style={styles.targets}>
            {entry.global && (
              <Bubble colors={GLOBAL_CONTEXT_COLORS} interactive onClick={() => { hover(null); setContext(null); }}>{m["image_export.zone_context.global"]()}</Bubble>
            )}
            {targets(entry).map((t) => (
              <Bubble
                key={t.key}
                colors={t.colors}
                interactive
                onMouseEnter={() => hover(t.target)}
                onMouseLeave={() => hover(null)}
                onClick={() => { hover(null); showTarget(t.target); setContext(t.target); }}
              >
                {t.label}
              </Bubble>
            ))}
          </div>
          {entry.value !== undefined && (
            <span style={styles.value}>
              {isColor && typeof entry.value === "number" && <span style={{ ...styles.swatch, background: cssColor(entry.value) }} />}
              {formatValue(registry, path, entry.value)}
            </span>
          )}
          {entry.linkEnabled !== undefined && (
            <span style={styles.value}>{m[entry.linkEnabled ? "image_export.zone_overrides.link_on" : "image_export.zone_overrides.link_off"]()}</span>
          )}
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { display: "flex", flexDirection: "column", gap: spacing.itemGap },
  list: { display: "flex", flexDirection: "column", gap: spacing.itemGap, paddingLeft: indent.tree },
  row: { display: "flex", alignItems: "center", gap: spacing.itemGap },
  targets: { flex: 1, minWidth: 0, display: "flex", flexWrap: "wrap", alignItems: "center", gap: spacing.itemGap },
  value: { ...muted(typography.body), display: "inline-flex", alignItems: "center", gap: spacing.itemGap / 2 },
  swatch: { width: 12, height: 12, borderRadius: 2, border: "1px solid currentColor", display: "inline-block" },
};
