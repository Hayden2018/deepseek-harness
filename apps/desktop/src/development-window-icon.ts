/** Native window icons for unpackaged Windows launches; packaged apps retain their executable icon. */
import { app, type BrowserWindow } from 'electron'

/**
 * Install before creating windows; remove the listener when Electron quits.
 * Packaged applications and other platforms keep their native icon behavior.
 * @param iconPath - Existing application artwork used by the desktop About panel.
 */
export function installDevelopmentWindowIcon(iconPath: string): void {
  if (process.platform !== 'win32' || app.isPackaged) return
  const setIcon = (_event: Electron.Event, window: BrowserWindow): void => { window.setIcon(iconPath) }
  app.on('browser-window-created', setIcon)
  app.once('will-quit', () => { app.off('browser-window-created', setIcon) })
}
