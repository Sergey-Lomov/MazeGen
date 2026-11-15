import type React from "react";
import { ChevronDown, ChevronUp, FolderOpen, Plus, Save, Settings, Trash2, X } from "lucide-react";
import { FlatIconButton } from "./FlatIconButton";

/** Standard compact actions. The registry owns their glyph and 16 px visual size. */
export type IconAction = "add" | "close" | "delete" | "edit" | "info" | "load" | "move-down" | "move-up" | "save" | "settings";

export function IconActionGlyph({ action }: { action: IconAction }) {
  switch (action) {
    case "add": return <Plus size={16} strokeWidth={2.5} />;
    case "close": return <X size={16} />;
    case "delete": return <Trash2 size={16} />;
    case "edit": return <span aria-hidden="true">✎</span>;
    case "info": return <span aria-hidden="true">ℹ</span>;
    case "load": return <FolderOpen size={16} />;
    case "move-down": return <ChevronDown size={16} />;
    case "move-up": return <ChevronUp size={16} />;
    case "save": return <Save size={16} />;
    case "settings": return <Settings size={16} />;
  }
}

type Props = Omit<React.ComponentProps<typeof FlatIconButton>, "children"> & { action: IconAction };

/** Semantic compact action backed by the shared flat surface. */
export function IconActionButton({ action, ...props }: Props) {
  return <FlatIconButton {...props}><IconActionGlyph action={action} /></FlatIconButton>;
}
