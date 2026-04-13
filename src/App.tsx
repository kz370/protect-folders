import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

type FolderStatus = {
  path: string
  is_locked: boolean
}

type Toast = {
  id: number
  message: string
  type: 'success' | 'error'
}

function App() {
  const [folderPath, setFolderPath] = useState('')
  const [folders, setFolders] = useState<FolderStatus[]>([])
  const [startupFailures, setStartupFailures] = useState<string[]>([])
  const [startWithWindows, setStartWithWindows] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const protectionActive = useMemo(() => folders.some(f => f.is_locked), [folders])

  const addToast = (message: string, type: Toast['type']) => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, 2500)
  }

  const refreshFolders = async () => {
    try {
      const folderList = await invoke<FolderStatus[]>('get_folders_with_status')
      setFolders(folderList)
    } catch {
      addToast('Failed to load folders', 'error')
    }
  }

  useEffect(() => {
    void refreshFolders()
    invoke<string[]>('get_relock_failures')
      .then((failures) => {
        setStartupFailures(failures)
        failures.forEach((failure) => addToast(`Startup re-lock failed: ${failure}`, 'error'))
      })
      .catch(() => addToast('Failed to read startup relock errors', 'error'))
    invoke<boolean>('get_autostart_status')
      .then((enabled) => setStartWithWindows(enabled))
      .catch(() => addToast('Failed to read startup status', 'error'))
  }, [])

  const onCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      addToast('Path copied', 'success')
    } catch {
      addToast('Clipboard copy failed', 'error')
    }
  }

  const onBrowse = async () => {
    const selected = await open({ directory: true, multiple: false })
    if (typeof selected === 'string') {
      setFolderPath(selected)
    }
  }

  const onAddFolder = async () => {
    if (!folderPath.trim()) {
      addToast('Enter a folder path first', 'error')
      return
    }

    setIsBusy(true)
    try {
      await invoke('add_folder', { path: folderPath })
      await refreshFolders()
      addToast('Folder added and locked', 'success')
      setFolderPath('')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const onToggleLock = async (path: string) => {
    setIsBusy(true)
    try {
      await invoke('toggle_folder_lock', { path })
      await refreshFolders()
      addToast('Lock toggled', 'success')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const onDeleteFolder = async (path: string) => {
    setIsBusy(true)
    try {
      await invoke('remove_folder', { path })
      await refreshFolders()
      addToast('Folder removed', 'success')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const onUnlockAll = async () => {
    setIsBusy(true)
    try {
      await invoke('unlock_all')
      await refreshFolders()
      addToast('All folders unlocked', 'success')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const onExportSettings = async () => {
    try {
      const path = await save({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        defaultPath: 'folder-locker-settings.json'
      })
      if (path) {
        await invoke('export_settings', { path })
        addToast('Settings exported', 'success')
      }
    } catch (error) {
      addToast(String(error), 'error')
    }
  }

  const onImportSettings = async () => {
    try {
      const path = await open({
        filters: [{ name: 'JSON', extensions: ['json'] }],
        multiple: false
      })
      if (typeof path === 'string') {
        await invoke('import_settings', { path })
        await refreshFolders()
        addToast('Settings imported', 'success')
      }
    } catch (error) {
      addToast(String(error), 'error')
    }
  }

  const onToggleAutostart = async () => {
    const next = !startWithWindows
    try {
      await invoke('set_autostart', { enabled: next })
      setStartWithWindows(next)
      addToast(next ? 'Startup enabled' : 'Startup disabled', 'success')
    } catch (error) {
      addToast(String(error), 'error')
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[480px] flex-col bg-gray-950 p-4 text-gray-100">
      <header className="mb-4 rounded-2xl border border-gray-800 bg-gray-900/50 p-5 backdrop-blur-xl shadow-2xl">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black tracking-tight bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">
              Folder Locker
            </h1>
            <p className="text-[10px] text-gray-500 uppercase tracking-widest font-bold mt-1">Security Dashboard</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span
              className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider ${
                protectionActive ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'
              }`}
            >
              • {protectionActive ? 'Active' : 'Idle'}
            </span>
          </div>
        </div>
      </header>

      <section className="mb-4 rounded-2xl border border-gray-800 bg-gray-900/30 p-5">
        <h2 className="mb-4 text-xs font-bold uppercase tracking-[0.2em] text-gray-500">Protect New Folder</h2>
        <div className="flex flex-col gap-3">
          <div className="relative group">
            <input
              type="text"
              placeholder="C:\\Path\\To\\Folder"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
              className="w-full rounded-xl border border-gray-700 bg-gray-800/50 px-4 py-3 text-sm text-gray-100 outline-none transition-all focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 group-hover:border-gray-600"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onBrowse}
              disabled={isBusy}
              className="rounded-xl bg-gray-800 px-4 py-3 text-sm font-bold text-gray-300 transition-all hover:bg-gray-700 active:scale-95 disabled:opacity-50"
            >
              Browse
            </button>
            <button
              type="button"
              onClick={onAddFolder}
              disabled={isBusy}
              className="rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-50"
            >
              Add &amp; Lock
            </button>
          </div>
        </div>
      </section>

      <section className="mb-4 flex-1 rounded-2xl border border-gray-800 bg-gray-900/30 p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-gray-500">Protected Vault</h2>
          <span className="text-[10px] text-gray-600 font-mono">{folders.length} items</span>
        </div>
        
        {startupFailures.length > 0 && (
          <div className="mb-4 border-l-2 border-amber-500 bg-amber-500/5 p-3 text-xs text-amber-200/80">
            <p className="mb-1 font-bold text-amber-400">Startup Re-lock Alerts:</p>
            {startupFailures.map((failure) => (
              <p key={failure} className="truncate opacity-75">- {failure}</p>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto pr-2 custom-scrollbar">
          {folders.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center border-2 border-dashed border-gray-800 rounded-2xl p-8 text-center">
              <span className="text-4xl mb-4 opacity-20">📁</span>
              <p className="text-sm font-medium text-gray-500">Your vault is empty</p>
              <p className="text-[10px] text-gray-600 mt-1 uppercase tracking-tight">Add a folder to get started</p>
            </div>
          ) : (
            folders.map((f) => (
              <div key={f.path} className="group relative rounded-xl border border-gray-800 bg-gray-900/60 p-4 transition-all hover:border-gray-700 hover:bg-gray-800/40">
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-gray-200" title={f.path}>
                      {f.path.split(/[\/\\]/).pop()}
                    </p>
                    <p className="truncate text-[10px] text-gray-500 font-mono mt-0.5" title={f.path}>
                      {f.path}
                    </p>
                  </div>
                  <button
                    onClick={() => onDeleteFolder(f.path)}
                    className="p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                    title="Remove from list"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>
                
                <div className="flex items-center gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => onToggleLock(f.path)}
                    disabled={isBusy}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition-all active:scale-[0.98] ${
                      f.is_locked 
                        ? 'bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20' 
                        : 'bg-green-500/10 text-green-400 border border-green-500/20 hover:bg-green-500/20'
                    }`}
                  >
                    {f.is_locked ? 'Unlock Folder' : 'Lock Folder'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onCopyPath(f.path)}
                    className="rounded-lg bg-gray-800 p-2 text-gray-400 hover:bg-gray-700 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                    </svg>
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mb-4 grid grid-cols-2 gap-3">
        <button
          onClick={onImportSettings}
          className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900/30 p-3 text-xs font-bold text-gray-400 transition-all hover:bg-gray-800/50 hover:text-gray-200"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
          </svg>
          Import
        </button>
        <button
          onClick={onExportSettings}
          className="flex items-center justify-center gap-2 rounded-xl border border-gray-800 bg-gray-900/30 p-3 text-xs font-bold text-gray-400 transition-all hover:bg-gray-800/50 hover:text-gray-200"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          Export
        </button>
      </section>

      <footer className="rounded-2xl border border-gray-800 bg-gray-900/50 p-5">
        <div className="flex items-center justify-between mb-4">
          <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">Windows Startup</span>
          <button
            type="button"
            onClick={onToggleAutostart}
            className={`h-6 w-11 rounded-full p-1 transition-all ${
              startWithWindows ? 'bg-blue-600' : 'bg-gray-800'
            }`}
          >
            <div
              className={`h-4 w-4 rounded-full bg-white transition-all transform ${
                startWithWindows ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
        <button
          type="button"
          onClick={onUnlockAll}
          disabled={isBusy || folders.length === 0}
          className="w-full rounded-xl bg-amber-500/10 border border-amber-500/20 px-4 py-3 text-sm font-black text-amber-500 transition-all hover:bg-amber-500/20 active:scale-95 disabled:opacity-30 disabled:grayscale"
        >
          FORCE UNLOCK ALL
        </button>
        <p className="mt-4 text-center text-[10px] font-bold text-gray-600 uppercase tracking-widest">
          App must remain in tray for protection
        </p>
      </footer>

      <div className="pointer-events-none fixed right-4 top-4 space-y-2 z-50">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-xl px-4 py-3 text-xs font-bold shadow-2xl border animate-in slide-in-from-right duration-300 ${
              toast.type === 'success'
                ? 'bg-green-950/90 text-green-400 border-green-500/20'
                : 'bg-red-950/90 text-red-400 border-red-500/20'
            }`}
          >
            {toast.message}
          </div>
        ))}
      </div>
    </main>
  )
}

export default App
