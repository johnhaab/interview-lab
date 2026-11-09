import { useCallback, useEffect, useState } from 'react'
import { Database, RefreshCw } from 'lucide-react'

import { Button } from '@/components/ui/button'

type Status = Awaited<ReturnType<typeof window.api.database.getStatus>>

export default function App(): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(() => {
    setError(null)
    window.api.database.getStatus().then(setStatus).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Could not connect to SQLite')
    })
  }, [])

  useEffect(loadStatus, [loadStatus])

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden bg-background px-6 py-12 text-foreground">
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_15%,oklch(0.55_0.18_265/0.16),transparent_32rem),radial-gradient(circle_at_85%_80%,oklch(0.7_0.16_165/0.1),transparent_28rem)]" />

      <div className="w-full max-w-3xl space-y-8">
        <section className="space-y-4">
          <span className="text-xs font-semibold tracking-[0.18em] text-muted-foreground uppercase">
            Starter project
          </span>
          <h1 className="text-4xl font-semibold tracking-tight sm:text-6xl">
            Electron + React + TypeScript
          </h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground sm:text-lg">
            Tailwind CSS and shadcn/ui are ready in the renderer. Drizzle ORM manages the
            SQLite database in Electron&apos;s main process.
          </p>
        </section>

        <section
          className="rounded-xl border bg-card/80 p-5 text-card-foreground shadow-2xl shadow-black/20 backdrop-blur"
          aria-live="polite"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-lg border bg-muted">
                <Database className="size-4" />
              </span>
              <div>
                <p className="font-medium">SQLite via Drizzle ORM</p>
                <p className="text-sm text-muted-foreground">Local application database</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={loadStatus}>
              <RefreshCw data-icon="inline-start" />
              Refresh
            </Button>
          </div>

          {error && <p className="mt-5 text-sm text-destructive">{error}</p>}
          {!error && !status && <p className="mt-5 text-sm text-muted-foreground">Connecting…</p>}
          {status && (
            <dl className="mt-5 grid gap-3 border-t pt-5 text-sm">
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Status</dt>
                <dd className="m-0 flex items-center gap-2">
                  <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_0_4px_oklch(0.7_0.17_165/0.12)]" />
                  {status.connected ? 'Connected' : 'Disconnected'}
                </dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="m-0">{status.sqliteVersion}</dd>
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4">
                <dt className="text-muted-foreground">Database</dt>
                <dd className="m-0 truncate" title={status.path}>
                  {status.path}
                </dd>
              </div>
            </dl>
          )}
        </section>
      </div>
    </main>
  )
}
