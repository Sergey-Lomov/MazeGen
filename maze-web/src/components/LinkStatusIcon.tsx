import type React from "react";
import { useState } from "react";
import { Link, Unlink, ArrowDown, X } from "lucide-react";
import { ui, typography, controlRowHeight } from "../styles/theme";
import { Modal } from "./Modal";
import { LinkEditor, linkModifiersSuffix } from "./features/ParameterLinksDialog";
import { Tooltip } from "./Tooltip";
import type { ParamDescriptor, ParamLink, ParamModifier, ColorModifier } from "../store/parameterLinks";
import { useMazeStore } from "../store/mazeStore";
import * as m from "~/paraglide/messages";

type LinkStatus = "active" | "disabled" | "noIncoming" | "noLinks";

const tooltipHeaderStyles: Record<LinkStatus, React.CSSProperties> = {
  active: { display: "block", color: ui.text.success },
  disabled: { display: "block", color: ui.text.disabled },
  noIncoming: { display: "block", color: ui.text.info },
  noLinks: { display: "block", color: ui.text.primary },
};

/** Disabled links remain listed, but use muted gray so they cannot be confused with active links.
 *  The semantic header color adds a quick visual cue without replacing its textual status. */
function LinkStatusTooltip({
  status,
  header,
  lines,
  hint,
}: {
  status: LinkStatus;
  header: string;
  lines: { text: string; disabled: boolean }[];
  hint: string;
}) {
  return (
    <>
      <span style={tooltipHeaderStyles[status]}>{header}</span>
      {lines.map((line, index) => (
        <span key={index} style={line.disabled ? styles.tooltipLinkDisabled : styles.tooltipLink}>
          {line.text}
        </span>
      ))}
      <span style={styles.tooltipHint}>{hint}</span>
    </>
  );
}

function UnsupportedLinkTooltip({ header, hint }: { header: string; hint: string }) {
  return (
    <>
      <span style={styles.tooltipUnsupportedHeader}>{header}</span>
      <span style={styles.tooltipHint}>{hint}</span>
    </>
  );
}

/** Per-field link-status icon (GitHub issue #652) — replaces the old reset-only
 *  `OverrideResetButton` with a richer control that shows link state at a glance and opens the
 *  add/edit link dialog directly from the field, rather than only clearing an override. The chain
 *  glyph (`Link`/`Unlink`) is the core; small corner badges show driving/dependent state.
 *
 *  Terminology (GitHub issue #652 follow-up):
 *  - "Driving link" (управляющая связь) — the link where this field is the *target* (`incoming`):
 *    this field follows another one's value.
 *  - "Dependent link" (зависимая связь) — a link where this field is the *source* (`outgoing`):
 *    another field follows this one's value.
 *  - "Driving indicator" — green `ArrowDown` badge, top-left corner: a driving link exists.
 *  - "Dependents indicator" — blue `ArrowDown` badge, bottom-right corner: at least one
 *    dependent link exists.
 *  - "Unsupported indicator" — red `X` badge, bottom-right corner, over a disabled-gray chain:
 *    linking isn't possible at all for this field (not merely unset).
 *
 *  States:
 *  - No link at all (but linkable): `Unlink`, disabled gray; no badge at all — the broken chain
 *    glyph alone says "no link", there's nothing further to indicate.
 *  - Driving link disabled (override), no dependents: `Link`, disabled gray; no badge (a disabled
 *    driving link isn't "active", so neither indicator applies — see `hasAnyLink` guard below).
 *  - Driving link disabled (override), with dependents: `Link`, disabled gray; blue `ArrowDown`
 *    (dependents indicator) only — badge colors are never affected by the chain's own disabled
 *    state.
 *  - Driving link enabled: `Link`, normal (non-disabled) color; green `ArrowDown` (driving
 *    indicator), plus blue `ArrowDown` alongside it if dependents also exist.
 *  - Dependents only (no driving link at all): `Link`, normal color; blue `ArrowDown` only.
 *  - Unsupported (`target === null`) — the field isn't in the mode's `ParamDescriptor` registry at
 *    all, so linking it is impossible rather than merely unset. Every field still gets an icon, so
 *    "always" visibility truly means always. `Unlink`, disabled gray (same as the plain "no link"
 *    case — this isn't a more severe state, just a different reason), red `X` badge (unsupported
 *    indicator); click opens a small info dialog explaining why instead of `LinkEditor`.
 *
 *  Click behavior: no driving link opens `LinkEditor` preselected to `target`; an enabled driving
 *  link opens `LinkEditor` prefilled with that link's endpoints; a disabled (override) driving link
 *  re-enables it directly (`onSetLinkEnabled(target, true)`), snapping the field back to following
 *  its source — no dialog. Unsupported fields (`target === null`) always open the info dialog.
 *
 *  Gated by `ImageExportState.linkIconVisibility` (GitHub issue #652 follow-up), read straight from
 *  the store rather than threaded through every call site (it's one global switch shared by both
 *  render modes' "Shared style" section, not a per-mode setting): `"always"` always renders,
 *  `"never"` never does (returns `null`), `"linked"` only when `target` has a driving link
 *  (enabled or not) or at least one dependent link (enabled or not) — an unsupported field never
 *  qualifies as "linked", so `"linked"` visibility hides it same as `"never"`. */
export function LinkStatusIcon<P extends string>({
  target,
  links,
  registry,
  onSetLinkEnabled,
  onAddLink,
  unsupportedHint,
  activePaths,
  onToggleLink,
  alwaysVisible = false,
}: {
  target: P | null;
  links: ParamLink<P>[];
  registry: Record<P, ParamDescriptor>;
  onSetLinkEnabled: (target: P, enabled: boolean) => void;
  onAddLink: (source: P, target: P, modifiers?: ParamModifier[], colorModifiers?: ColorModifier[]) => void;
  /** Overrides the default "type not supported" explanation for a field that's unsupported for
   *  a reason other than a missing enum type — e.g. a toggle that actually drives a multi-value
   *  field underneath it, where the generic hint would be misleading. */
  unsupportedHint?: string;
  /** Paths currently shown in the settings panel (GitHub issue #670), passed through to `LinkEditor`. */
  activePaths: Set<P>;
  /** Read-only "group mode" (GitHub issue #729): the links are derived, not editable — a click on a
   *  field with a driving link calls this (break when active, restore when disabled) instead of
   *  opening `LinkEditor`/`onSetLinkEnabled`; a field without one does nothing. */
  onToggleLink?: () => void;
  /** Ignores `linkIconVisibility` — the icon always renders (group mode, GitHub issue #729). */
  alwaysVisible?: boolean;
}) {
  const storeVisibility = useMazeStore((s) => s.linkIconVisibility);
  const visibility = alwaysVisible ? "always" : storeVisibility;
  const [editing, setEditing] = useState(false);
  const [showUnsupportedInfo, setShowUnsupportedInfo] = useState(false);

  // Fills the row's own control height (`ColorSwatch`/`SelectRow`'s native `<select>`, etc.) rather
  // than a smaller fixed size, so the icon doesn't look undersized next to them.
  const iconSize = controlRowHeight - 9;
  const badgeSize = iconSize - 4;

  if (visibility === "never") return null;
  if (visibility === "linked" && target === null) return null;

  if (target === null) {
    if (visibility === "linked") return null;
    const hint = unsupportedHint ?? m["link_status.unsupported_hint"]();
    return (
      <>
        <Tooltip
          content={<UnsupportedLinkTooltip header={m["link_status.header_unsupported"]()} hint={hint} />}
          bubbleStyle={styles.tooltipBubble}
        >
          <span
            className="hoverable"
            style={styles.wrapper}
            onClick={() => setShowUnsupportedInfo(true)}
          >
            <Unlink size={iconSize} color={ui.text.disabled} strokeWidth={2.5} />
            <span style={styles.badge}>
              <X size={badgeSize} color={ui.text.error} strokeWidth={2.5} />
            </span>
          </span>
        </Tooltip>
        {showUnsupportedInfo && (
          <Modal title={m["link_status.header_unsupported"]()} onClose={() => setShowUnsupportedInfo(false)}>
            <div style={typography.body}>{hint}</div>
          </Modal>
        )}
      </>
    );
  }

  const linkTarget: P = target;
  const incoming = links.find((l) => l.target === linkTarget) ?? null;
  const hasOutgoing = links.some((l) => l.source === linkTarget);
  const incomingActive = incoming?.enabled === true;
  const hasLink = incoming !== null;
  const hasAnyLink = incoming !== null || hasOutgoing;

  if (visibility === "linked" && !hasAnyLink) return null;

  function hierarchicalLabel(path: P): string {
    const { group, label } = registry[path];
    return group.length === 0 ? label : `${group.join(" / ")} / ${label}`;
  }

  function handleClick() {
    if (onToggleLink) {
      if (incoming !== null) onToggleLink();
    } else if (incoming === null) {
      setEditing(true);
    } else if (incoming.enabled) {
      setEditing(true);
    } else {
      onSetLinkEnabled(linkTarget, true);
    }
  }

  const status: LinkStatus = hasLink
    ? incomingActive ? "active" : "disabled"
    : hasAnyLink ? "noIncoming" : "noLinks";
  const header = status === "active"
    ? m["link_status.header_active"]()
    : status === "disabled"
      ? m["link_status.header_disabled"]()
      : status === "noIncoming"
        ? m["link_status.header_no_incoming"]()
        : m["link_status.header_no_links"]();
  const tooltipLines: { text: string; disabled: boolean }[] = [];
  if (incoming !== null) {
    const line = m["link_status.incoming_line"]({ source: hierarchicalLabel(incoming.source) }) + linkModifiersSuffix(incoming);
    tooltipLines.push({ text: incoming.enabled ? line : `${line} ${m["link_status.disabled_suffix"]()}`, disabled: !incoming.enabled });
  }
  // Rule 5: list every dependent link, active or not — the badge/indicator only reflects
  // *active* dependents, but the tooltip's detail list is a complete inventory of all links.
  for (const link of links.filter((l) => l.source === linkTarget)) {
    const line = m["link_status.outgoing_line"]({ target: hierarchicalLabel(link.target) }) + linkModifiersSuffix(link);
    tooltipLines.push({ text: link.enabled ? line : `${line} ${m["link_status.disabled_suffix"]()}`, disabled: !link.enabled });
  }
  let hint: string;
  if (onToggleLink) {
    hint = incoming === null
      ? m["link_status.hint_group_no_link"]()
      : incoming.enabled
        ? m["link_status.hint_group_break"]()
        : m["link_status.hint_group_restore"]();
  } else if (incoming === null) hint = m["link_status.hint_click_to_link"]();
  else if (incoming.enabled) hint = m["link_status.hint_click_to_edit"]();
  else hint = m["link_status.hint_click_to_enable"]();
  const tooltip = <LinkStatusTooltip status={status} header={header} lines={tooltipLines} hint={hint} />;

  // Rule 4: the chain glyph itself is disabled-colored whenever there's no *active* link driving
  // this field — either no link at all, or a driving link that exists but is disabled (override).
  // An active driving link, or dependents with no driving link at all, both count as "has an active
  // link" and get the normal (non-disabled) chain color.
  const chainActive = incomingActive || (!hasLink && hasOutgoing);
  const chainColor = chainActive ? ui.text.secondary : ui.text.disabled;
  const ChainIcon = hasAnyLink ? Link : Unlink;

  return (
    <>
      <Tooltip content={tooltip} bubbleStyle={styles.tooltipBubble}>
        <span className="hoverable" style={styles.wrapper} onClick={handleClick}>
        <ChainIcon size={iconSize} color={chainColor} strokeWidth={2.5} />
        {/* Rule 1/4: driving indicator (green) whenever a driving link exists, active or
         *  disabled — indicators stay colored even while the chain itself goes disabled-gray.
         *  Top-left corner, distinct from the bottom-right dependents/unsupported badge. */}
        {hasLink && (
          <span style={styles.badgeTop}>
            <ArrowDown size={badgeSize} color={ui.text.success} strokeWidth={2.5} />
          </span>
        )}
        <span style={styles.badge}>
          {/* Dependents indicator (blue) whenever at least one dependent link exists, active or
           *  disabled. No badge at all when there's no link of either kind — that's the chain's
           *  own broken (`Unlink`) glyph's job to communicate, not a separate indicator. */}
          {hasOutgoing && <ArrowDown size={badgeSize} color={ui.text.info} strokeWidth={2.5} />}
        </span>
        </span>
      </Tooltip>
      {editing && (
        <LinkEditor
          registry={registry}
          activePaths={activePaths}
          existingLinks={links}
          initialSource={incoming?.source ?? null}
          initialTarget={linkTarget}
          initialModifiers={incoming?.modifiers}
          initialColorModifiers={incoming?.colorModifiers}
          onSave={(source, newTarget, modifiers, colorModifiers) => {
            onAddLink(source, newTarget, modifiers, colorModifiers);
            setEditing(false);
          }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: controlRowHeight,
    height: controlRowHeight,
    flexShrink: 0,
    cursor: "default",
    borderRadius: 3,
  },
  badge: {
    position: "absolute",
    right: 0,
    bottom: 0,
    display: "flex",
    alignItems: "center",
  },
  badgeTop: {
    position: "absolute",
    left: 0,
    top: 0,
    display: "flex",
    alignItems: "center",
  },
  // The bubble grows to fit ordinary link names, then wraps them at this local cap. Other tooltips
  // retain Tooltip's compact default width and wrapping behavior.
  tooltipBubble: { width: "max-content", maxWidth: 560, overflowWrap: "anywhere" },
  tooltipLink: { display: "block", color: ui.text.primary },
  tooltipLinkDisabled: { display: "block", color: ui.text.disabled },
  tooltipUnsupportedHeader: { display: "block", color: ui.text.error },
  tooltipHint: { display: "block", marginTop: 2, color: ui.text.tertiary },
};
