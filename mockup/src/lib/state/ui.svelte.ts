/**
 * App-wide dialogs and toasts. `confirmDialog` resolves when the person decides; toasts may carry
 * one action (Undo, Open).
 */
import type { BlockingRef } from '#lib/api/errors.js';

export type DialogRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  tone: 'primary' | 'danger';
  /** An extra warning line, e.g. that the API cannot undo this. */
  note: string | null;
  resolve: (confirmed: boolean) => void;
};

export type Toast = {
  id: number;
  tone: 'success' | 'error' | 'info';
  title: string;
  body: string | null;
  refs: BlockingRef[];
  action: { label: string; run: () => void } | null;
  /** Operation name shown in Expert mode. */
  operation: string | null;
};

export const ui = $state<{ dialog: DialogRequest | null; toasts: Toast[] }>({
  dialog: null,
  toasts: []
});

export function confirmDialog(
  request: Omit<DialogRequest, 'resolve'>
): Promise<boolean> {
  return new Promise(resolve => {
    ui.dialog = {
      ...request,
      resolve: confirmed => {
        ui.dialog = null;
        resolve(confirmed);
      }
    };
  });
}

let nextToast = 1;
const TOAST_MS = 6000;
const ERROR_TOAST_MS = 9000;

export function toast(
  input: Omit<Toast, 'id' | 'refs' | 'action' | 'body' | 'operation'> &
    Partial<Toast>
): number {
  const id = nextToast;
  nextToast += 1;
  ui.toasts = [
    ...ui.toasts,
    { refs: [], action: null, body: null, operation: null, ...input, id }
  ].slice(-4);
  setTimeout(
    () => dismissToast(id),
    input.tone === 'error' ? ERROR_TOAST_MS : TOAST_MS
  );
  return id;
}

export function dismissToast(id: number): void {
  ui.toasts = ui.toasts.filter(item => item.id !== id);
}
