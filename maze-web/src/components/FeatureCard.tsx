import React from "react";
import { colors, font } from "../styles/theme";

export type FeatureStatus = "unavailable" | "available" | "set-default" | "set";

export interface FeatureCardProps {
  title: string;
  status: FeatureStatus;
  comment?: string;
  subtitle?: string;
  expanded: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}

const STATUS_FILL: Record<FeatureStatus, string> = {
  unavailable: "transparent",
  available: colors.featureStatusAvailable,
  "set-default": colors.featureStatusSetDefault,
  set: colors.featureStatusSet,
};

const STATUS_BORDER_COLOR: Record<FeatureStatus, string> = {
  unavailable: colors.featureStatusAvailable,
  available: colors.featureStatusAvailable,
  "set-default": colors.featureStatusSetDefault,
  set: colors.featureStatusSet,
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

export function FeatureCard({ title, status, comment, subtitle, expanded, onToggle, children }: FeatureCardProps) {
  const canExpand = status !== "unavailable";

  return (
    <div style={styles.card}>
      <button
        style={{ ...styles.header, ...(canExpand ? styles.headerClickable : styles.headerDisabled) }}
        onClick={canExpand ? onToggle : undefined}
        disabled={!canExpand}
      >
        <StatusDot status={status} />
        <div style={styles.headerText}>
          <div style={styles.titleRow}>
            <span style={styles.title}>{title}</span>
            {canExpand && (
              <span style={styles.chevron}>{expanded ? "▲" : "▼"}</span>
            )}
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
    borderBottom: `1px solid ${colors.borderDim}`,
  },
  header: {
    width: "100%",
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    background: "transparent",
    border: "none",
    textAlign: "left",
  },
  headerClickable: {
    cursor: "pointer",
  },
  headerDisabled: {
    cursor: "default",
    opacity: 0.5,
  },
  headerText: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  titleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 6,
  },
  title: {
    fontSize: font.lg,
    fontWeight: 600,
    color: colors.textSecondary,
  },
  comment: {
    fontSize: font.sm,
    color: colors.textVeryDim,
  },
  subtitle: {
    fontSize: font.sm,
    color: colors.textFaint,
  },
  chevron: {
    fontSize: font.xs,
    color: colors.textDisabled,
    flexShrink: 0,
  },
  body: {
    padding: "0 12px 12px",
  },
};
