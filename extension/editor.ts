/**
 * Editor that turns "left arrow at the start of the first line" into a gesture.
 *
 * This replaces the whole input box for every pi session that loads the package,
 * so it passes everything else straight through. See docs/adr/0004.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export interface GestureHandlers {
  /** Called when the gesture fires. */
  onGesture: () => void;
  /** True while something else owns the screen; the gesture is suppressed. */
  isBlocked: () => boolean;
}

export function createGestureEditor(handlers: GestureHandlers) {
  return class GestureEditor extends CustomEditor {
    /** Cursor sits at column 0 of the first logical line. */
    private atStart(): boolean {
      const state = (this as any).state as { cursorLine: number; cursorCol: number } | undefined;
      return state?.cursorLine === 0 && state?.cursorCol === 0;
    }

    handleInput(data: string): void {
      if (matchesKey(data, "left") && this.atStart() && !handlers.isBlocked()) {
        handlers.onGesture();
        return;
      }
      super.handleInput(data);
    }
  };
}
