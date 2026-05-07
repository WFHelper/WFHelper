import { dialog } from "electron";
import type { IpcMainInvokeEvent } from "electron";

import ctx from "./context";

interface TradeMutationConfirmation {
  title: string;
  message: string;
  detail?: string;
}

export async function confirmTradeMutation(
  event: IpcMainInvokeEvent,
  confirmation: TradeMutationConfirmation,
): Promise<boolean> {
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed() || event.sender.id !== win.webContents.id || !win.isFocused()) {
    return false;
  }

  const result = await dialog.showMessageBox(win, {
    type: "warning",
    title: confirmation.title,
    message: confirmation.message,
    detail: confirmation.detail,
    buttons: ["Cancel", "Allow"],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });

  return result.response === 1;
}

export function tradeMutationDenied(): { error: string } {
  return { error: "Trade action was not confirmed." };
}
