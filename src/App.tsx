import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

type Toast = {
  id: number
  message: string
  type: 'success' | 'error'
}

function App() {
  const [folderPath, setFolderPath] = useState('')
  const [lockedFolders, setLockedFolders] = useState<string[]>([])
  const [startupFailures, setStartupFailures] = useState<string[]>([])
  const [startWithWindows, setStartWithWindows] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])

  const protectionActive = useMemo(() => lockedFolders.length > 0, [lockedFolders.length])

  const addToast = (message: string, type: Toast['type']) => {
    const id = Date.now()
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
    }, 2500)
  }

  const refreshLockedFolders = async () => {
    try {
      const folders = await invoke<string[]>('get_locked_folders')
      setLockedFolders(folders)
    } catch {
      addToast('Failed to load locked folders', 'error')
    }
  }

  useEffect(() => {
    void refreshLockedFolders()
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

  const onAddAndLock = async () => {
    if (!folderPath.trim()) {
      addToast('Enter a folder path first', 'error')
      return
    }

    setIsBusy(true)
    try {
      await invoke('lock_folder', { path: folderPath })
      await refreshLockedFolders()
      addToast('Folder locked', 'success')
      setFolderPath('')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
    }
  }

  const onUnlock = async (path: string) => {
    setIsBusy(true)
    try {
      await invoke('unlock_folder', { path })
      await refreshLockedFolders()
      addToast('Folder unlocked', 'success')
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
      await refreshLockedFolders()
      addToast('All folders unlocked', 'success')
    } catch (error) {
      addToast(String(error), 'error')
    } finally {
      setIsBusy(false)
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
      <header className="mb-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-wide">🔒 Folder Locker</h1>
          <span
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              protectionActive ? 'bg-green-600/20 text-green-300' : 'bg-red-600/20 text-red-300'
            }`}
          >
            {protectionActive ? 'Protection Active' : 'No Folders Protected'}
          </span>
        </div>
      </header>

      <section className="mb-4 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">Add Folder</h2>
        <div className="flex flex-col gap-2">
          <input
            type="text"
            placeholder="C:\\Users\\Name\\Documents"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
          />
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onBrowse}
              disabled={isBusy}
              className="rounded-lg bg-gray-700 px-3 py-2 text-sm font-medium hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Browse
            </button>
            <button
              type="button"
              onClick={onAddAndLock}
              disabled={isBusy}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Add &amp; Lock
            </button>
          </div>
        </div>
      </section>

      <section className="mb-4 flex-1 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">Locked Folders</h2>
        {startupFailures.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-200">
            <p className="mb-1 font-semibold">Some folders could not be re-locked on startup:</p>
            {startupFailures.map((failure) => (
              <p key={failure} className="truncate">
                - {failure}
              </p>
            ))}
          </div>
        )}
        <div className="max-h-[270px] space-y-2 overflow-y-auto pr-1">
          {lockedFolders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-700 p-4 text-center text-sm text-gray-400">
              No locked folders yet.
            </div>
          ) : (
            lockedFolders.map((path) => (
              <div key={path} className="rounded-lg border border-gray-700 bg-gray-800 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs text-gray-300">📁 {path}</span>
                  <span className="rounded-full bg-green-600/20 px-2 py-1 text-[10px] font-semibold text-green-300">
                    Locked
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onUnlock(path)}
                  disabled={isBusy}
                  className="mb-2 w-full rounded-md bg-red-600 px-2 py-1.5 text-xs font-semibold hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Unlock
                </button>
                <button
                  type="button"
                  onClick={() => onCopyPath(path)}
                  className="w-full rounded-md bg-gray-700 px-2 py-1.5 text-xs font-semibold hover:bg-gray-600"
                >
                  Copy Path
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="mb-3 rounded-xl border border-gray-800 bg-gray-900 p-4">
        <label className="flex cursor-pointer items-center justify-between">
          <span className="text-sm text-gray-300">Start with Windows</span>
          <button
            type="button"
            onClick={onToggleAutostart}
            className={`h-6 w-11 rounded-full p-1 transition ${
              startWithWindows ? 'bg-green-600' : 'bg-gray-600'
            }`}
          >
            <span
              className={`block h-4 w-4 rounded-full bg-white transition ${
                startWithWindows ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </label>
      </section>

      <footer className="rounded-xl border border-gray-800 bg-gray-900 p-4">
        <button
          type="button"
          onClick={onUnlockAll}
          disabled={isBusy || lockedFolders.length === 0}
          className="mb-2 w-full rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-gray-900 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Unlock All
        </button>
        <p className="text-center text-xs text-gray-400">
          Keep Folder Locker running in tray to keep folders protected
        </p>
      </footer>

      <div className="pointer-events-none fixed right-4 top-4 space-y-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`rounded-md px-3 py-2 text-xs font-semibold shadow-lg ${
              toast.type === 'success'
                ? 'bg-green-700/90 text-green-100'
                : 'bg-red-700/90 text-red-100'
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
