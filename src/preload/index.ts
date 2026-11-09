import { contextBridge, ipcRenderer } from 'electron'
import type { DatabaseStatus } from '../shared/database'

const api = {
  database: {
    getStatus: (): Promise<DatabaseStatus> => ipcRenderer.invoke('database:status'),
    get: (key: string): Promise<string | null> => ipcRenderer.invoke('database:get', key),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('database:set', key, value)
  }
}

contextBridge.exposeInMainWorld('api', api)

export type AppApi = typeof api
