/** Selecting a pane in another session does not move the attached client there. */
export function focusTmuxPane(pane: string, run: (args: string[]) => string): void {
  run(["select-window", "-t", pane]);
  run(["select-pane", "-t", pane]);
  run(["switch-client", "-t", pane]);
}
