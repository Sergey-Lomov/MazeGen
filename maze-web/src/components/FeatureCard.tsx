import React from "react";
import { ui, typography, disabled, spacing, inset } from "../styles/theme";

export type FeatureStatus = "unavailable" | "set" | "warning" | "critical";

export interface FeatureCardProps {
  title: string;
  status: FeatureStatus;
  comment?: string;
  subtitle?: string;
  expanded: boolean;
  onOpen: () => void;
  children?: React.ReactNode;
}

const STATUS_FILL: Record<FeatureStatus, string> = {
  unavailable: "transparent",
  set: ui.status.set,
  warning: ui.status.warning,
  critical: ui.status.critical,
};

const STATUS_BORDER_COLOR: Record<FeatureStatus, string> = {
  unavailable: ui.status.unavailable,
  set: ui.status.set,
  warning: ui.status.warning,
  critical: ui.status.critical,
};

export function StatusDot({ status }: { status: FeatureStatus }) {
  return (
    <span
      style={{
        ...dotStyle,
        background: STATUS_FILL[status],
        border: `1px solid ${STATUS_BORDER_COLOR[status]}`,
      }}
    />
  );
}

export function FeatureCard({ title, status, comment, subtitle, expanded, onOpen, children }: FeatureCardProps) {
  const canExpand = status !== "unavailable";

  return (
    <div style={{ ...styles.card, ...(expanded && canExpand ? styles.cardExpanded : {}) }}>
      <button
        className={canExpand ? (expanded ? "hoverable-off" : "hoverable") : undefined}
        style={{ ...styles.header, ...(canExpand ? styles.headerClickable : styles.headerDisabled) }}
        onClick={canExpand ? onOpen : undefined}
        disabled={!canExpand}
      >
        <StatusDot status={status} />
        <div style={styles.headerText}>
          <div style={styles.titleRow}>
            <span style={styles.title}>{title}</span>
          </div>
          {comment && <span style={styles.comment}>{comment}</span>}
          {subtitle && <span style={styles.subtitle}>{subtitle}</span>}
        </div>
      </button>
      {expanded && canExpand && (
        <div style={styles.body}>
          {children}
        </div>
      )}
    </div>
  );
}

const dotStyle: React.CSSProperties = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  flexShrink: 0,
  marginTop: 3,
};

const styles: Record<string, React.CSSProperties> = {
  card: {
    borderBottom: `1px solid ${ui.border.default}`,
  },
  cardExpanded: {
    background: ui.bg.panelAlt,
  },
  header: {
    width: "100%",
    display: "flex",
    alignItems: "flex-start",
    gap: spacing.rowGap,
    padding: `${inset.panelInsetY}px ${inset.panelInsetX}px`,
    border: "none",
    textAlign: "left",
  },
  headerClickable: {
    cursor: "default",
  },
  headerDisabled: {
    cursor: "default",
    opacity: 0.5,
    background: "transparent",
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    gap: spacing.elementsGap,
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.itemGap,
  },
  title: {
    ...typography.title,
  },
  comment: {
    ...disabled(typography.body),
  },
  subtitle: {
    ...typography.caption,
  },
  body: {
    padding: `0 ${inset.panelInsetX}px ${inset.panelInsetX}px`,
  },
};
