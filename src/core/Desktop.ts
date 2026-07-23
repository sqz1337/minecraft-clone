import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export interface NativeWorldRecord {
  id: string
  name: string
  seed: string
  gameMode: 'creative' | 'survival'
  createdAt: number
  lastPlayed: number
  silentHill: boolean
}

export function isDesktopApp(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function native<T>(command: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isDesktopApp()) return null
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    console.warn(`[realmcraft:desktop] ${command} failed`, error)
    return null
  }
}

export const desktopWorlds = {
  list: () => native<NativeWorldRecord[]>('list_worlds'),
  register: (metadata: NativeWorldRecord) => native<boolean>('register_world', { metadata }),
  load: (worldId: string) => native<string | null>('load_world', { worldId }),
  save: (worldId: string, data: string, metadata: NativeWorldRecord) =>
    native<boolean>('save_world', { worldId, data, metadata }),
  delete: (worldId: string) => native<boolean>('delete_world', { worldId }),
  quit: () => native<void>('quit_app')
}

/** Native cursor capture avoids WebView2's browser-style Pointer Lock banner. */
export const desktopCursor = {
  lock: () => native<boolean>('set_game_cursor_lock', { locked: true }),
  unlock: () => native<boolean>('set_game_cursor_lock', { locked: false }),
  async listen(onDelta: (x: number, y: number) => void): Promise<UnlistenFn> {
    if (!isDesktopApp()) return () => {}
    return await listen<{ x: number; y: number }>('game-mouse-delta', event => {
      onDelta(event.payload.x, event.payload.y)
    })
  }
}

export const desktopWindow = {
  fullscreen: (fullscreen: boolean) => native<boolean>('set_app_fullscreen', { fullscreen })
}
