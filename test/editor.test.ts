import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchesKey } from "@earendil-works/pi-tui";
import { createGestureEditor } from "../extension/editor.ts";

function editor() {
  const state = { opened: 0, blocked: false, leftMovesCaret: true };
  const GestureEditor = createGestureEditor({
    onGesture: () => { state.opened++; },
    isBlocked: () => state.blocked,
  });
  const instance = new GestureEditor(
    { requestRender() {}, terminal: { rows: 24, columns: 80 } } as any,
    { borderColor: (text: string) => text, selectList: {} } as any,
    { matches: (data: string, action: string) => action === "tui.editor.cursorLeft" && state.leftMovesCaret && matchesKey(data, "left") } as any,
  );
  instance.focused = true;
  return { instance, state };
}

test("left opens only an empty focused editor, and preserves drafts at the start", () => {
  const { instance, state } = editor();
  instance.setText("draft");
  instance.handleInput("\x01");
  instance.handleInput("\x1b[D");
  assert.equal(instance.getText(), "draft");
  assert.equal(state.opened, 0);
  instance.setText("");
  instance.focused = false;
  instance.handleInput("\x1b[D");
  assert.equal(state.opened, 0);
  instance.focused = true;
  instance.handleInput("\x1b[D");
  assert.equal(state.opened, 1);
});

test("left respects remapping, modal UI, autocomplete and key repeats", () => {
  const { instance, state } = editor();
  state.leftMovesCaret = false;
  instance.handleInput("\x1b[D");
  state.leftMovesCaret = true;
  state.blocked = true;
  instance.handleInput("\x1b[D");
  state.blocked = false;
  instance.isShowingAutocomplete = () => true;
  instance.handleInput("\x1b[D");
  instance.isShowingAutocomplete = () => false;
  instance.handleInput("\x1b[1;1:2D");
  instance.handleInput("\x1b[1;1:3D");
  assert.equal(state.opened, 0);
});

test("a left key inside a pending paste does not open the panel", () => {
  const { instance, state } = editor();
  instance.handleInput("\x1b[200~");
  instance.handleInput("\x1b[D");
  instance.handleInput("\x1b[201~");
  assert.equal(state.opened, 0);
});
