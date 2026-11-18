import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { crosshairCursor, highlightActiveLine, keymap, rectangularSelection, type KeyBinding } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";

/**
 * Non-AI editing helpers shared by the answer editor and notebook cells:
 * auto-closed brackets/quotes, auto-indent, comment toggle (Ctrl+/), line
 * move/duplicate (Alt+↑/↓, Shift+Alt+↑/↓), multi-cursor (Ctrl+click, Ctrl+D,
 * Alt+drag), find/replace (Ctrl+F) and indent guides.
 */
export function editingExtensions(reservedKeys: ReadonlySet<string> = new Set()): Extension[] {
  const allowed = (binding: KeyBinding) => ![binding.key, binding.mac, binding.win, binding.linux].some(key => key !== undefined && reservedKeys.has(key));
  return [
    EditorState.allowMultipleSelections.of(true),
    closeBrackets(),
    indentOnInput(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    indentationMarkers({ thickness: 1, colors: { light: "#d0d0d0", dark: "#3a3a3a", activeLight: "#a0a0a0", activeDark: "#6a6a6a" } }),
    keymap.of([...closeBracketsKeymap, ...searchKeymap, ...defaultKeymap, ...historyKeymap].filter(allowed)),
  ];
}
