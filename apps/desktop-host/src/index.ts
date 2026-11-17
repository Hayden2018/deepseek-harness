/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, dirname, join } from 'node:path'
import { mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { formatFatalDiagnostic } from './fatal-diagnostic.ts'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { localDragResource } from './file-drag.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOperationDiagnostics } from './operation-diagnostics.ts'

interface DesktopWebExposure {
  readonly args: string[]
  readonly publicUrl: string | undefined
  readonly stateFile: string | undefined
}

interface DesktopWebStateRecord {
  readonly pid: number
  readonly ppid: number
  readonly port: number | undefined
  readonly localTokenUrl: string
  readonly tokenUrl: string
}

const WINDOWS_RENAME_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM'])

function resolveDesktopWebExposure(env: NodeJS.ProcessEnv): DesktopWebExposure {
  const rawPort = env.DSH_DESKTOP_WEB_PORT?.trim()
  let port = '0'
  if (rawPort !== undefined && rawPort !== '') {
    const parsed = Number(rawPort)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 65_535) {
      throw new Error(`desktop-host: DSH_DESKTOP_WEB_PORT must be an integer from 0 through 65535, got ${JSON.stringify(rawPort)}`)
    }
    port = String(parsed)
  }
  const rawPublicUrl = env.DSH_DESKTOP_WEB_PUBLIC_URL?.trim()
  const publicUrl = rawPublicUrl !== undefined && rawPublicUrl !== '' ? rawPublicUrl : undefined
  const trustedHosts = (env.DSH_DESKTOP_WEB_TRUSTED_HOSTS ?? '').split(/[\s,]+/u).filter(Boolean)
  const args = ['--no-open', '--host', '127.0.0.1', '--port', port]
  if (publicUrl !== undefined) args.push('--public-url', publicUrl)
  if (trustedHosts.length > 0) args.push('--trusted-host', ...trustedHosts)
  const rawStateFile = env.DSH_DESKTOP_WEB_STATE_FILE?.trim()
  const stateFile = rawStateFile !== undefined && rawStateFile !== '' ? rawStateFile : undefined
  return { args, publicUrl, stateFile }
}

async function writeWebStateFile(path: string, record: DesktopWebStateRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const staging = `${path}.${String(process.pid)}.${randomUUID()}.tmp`
  try {
    await writeFile(staging, `${JSON.stringify(record, undefined, 2)}\n`, { mode: 0o600, flag: 'wx' })
    for (let attempt = 0; ; attempt++) {
      try { await rename(staging, path); break }
      catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code ?? ''
        if (process.platform !== 'win32' || !WINDOWS_RENAME_TRANSIENT_CODES.has(code) || attempt >= 6) throw error
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, 25 * (attempt + 1)) })
    }
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

async function removeOwnedWebStateFile(path: string, ownerPid: number): Promise<void> {
  let raw: string
  try { raw = await readFile(path, 'utf8') }
  catch (_readError) { /* Absent or unreadable state file during shutdown requires no removal. */ return }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (_parseError) { /* Unparsable state file cannot be verified as owned by this process. */ return }
  if (typeof parsed !== 'object' || parsed === null || !('pid' in parsed) || parsed.pid !== ownerPid) return
  try { await unlink(path) }
  catch (_unlinkError) { /* Concurrent removal during shutdown already achieved the target state. */ }
}

async function main(): Promise<void> {
  const runId = randomUUID() as PluginOperationRunId
  if (process.connected) process.send?.({ type: 'starting', runId }, (error) => { if (error !== null) console.error(error) })
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  // Set before the launch-environment snapshot and profile evaluation; empty means the payload sits beside the runtime directory.
  process.env.DSH_PRIMARY_RUNTIME = process.argv[4] || join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const webExposure = resolveDesktopWebExposure(process.env)
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: webExposure.args,
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    if (webExposure.stateFile !== undefined) await removeOwnedWebStateFile(webExposure.stateFile, process.pid)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    // A handle a disposed plugin left open would otherwise keep the Host alive past the shell's graceful
    // deadline; a startup failure keeps its own diagnostic exit.
    if (running !== undefined) process.exit()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      const abort = new AbortController()
      dragReads.set(requestId, abort)
      const task = (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          const resource = await localDragResource(ctx, address, abort.signal)
          await send({ type: 'file-drag-resource', requestId, resource })
        } catch (error) {
          if (!abort.signal.aborted) console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        } finally { dragReads.delete(requestId) }
      })().catch((error: unknown) => { console.error(error) })
      dragTasks.add(task)
      void task.finally(() => { dragTasks.delete(task) })
      return
    }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  installOperationDiagnostics(ctx, record => send({ type: 'plugin-operation', record }), 32, runId)
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  const localOrigin = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`
  const url = ctx.connection.authenticatedUrl(localOrigin)
  if (webExposure.stateFile !== undefined) {
    await writeWebStateFile(webExposure.stateFile, {
      pid: process.pid,
      ppid: process.ppid,
      port: ctx.webServer.port,
      localTokenUrl: url,
      tokenUrl: ctx.connection.authenticatedUrl(webExposure.publicUrl ?? localOrigin),
    })
  }
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections(ctx.connection.browserPeer) }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = formatFatalDiagnostic(error)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
