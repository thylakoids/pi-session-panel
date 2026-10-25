/**
 * Editor that turns "left arrow in an empty input" into a gesture.
 *
 * This replaces the whole input box for every pi session that loads the package,
 * so it passes everything else straight through. See docs/adr/0004.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

export interface GestureHandlers {
  /** Called when the gesture fires. */
  onGesture: () => void;
  /** True while something else owns the screen; the gesture is suppressed. */
  isBlocked: () => boolean;
}

export function createGestureEditor(handlers: GestureHandlers) {
  return class GestureEditor extends CustomEditor {
    private pasting = false;
    private readonly gestureBindings: ConstructorParameters<typeof CustomEditor>[2];

    constructor(...args: ConstructorParameters<typeof CustomEditor>) {
      super(...args);
      this.gestureBindings = args[2];
    }

    handleInput(data: string): void {
      const paste = this.pasting || data.includes("\x1b[200~");
      this.pasting = paste && !data.includes("\x1b[201~");
      if (!paste && !isKeyRelease(data) && !isKeyRepeat(data)
        && matchesKey(data, "left") && this.gestureBindings.matches(data, "tui.editor.cursorLeft")
        && this.focused && this.getText() === "" && !this.isShowingAutocomplete() && !handlers.isBlocked()) {
        handlers.onGesture();
        return;
      }
      super.handleInput(data);
    }
  };
}
