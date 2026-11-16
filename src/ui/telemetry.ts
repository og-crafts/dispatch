/**
 * Opt-in usage analytics (Aptabase) and error reports (Sentry). Nothing is sent until the person says yes on the
 * first-launch screen or in Settings, and builds without the keys (development, forks) never send anything.
 *
 * What is sent is deliberately small (docs/TELEMETRY.md, and the privacy policy on the site):
 * - usage: an event name, a few fixed labels (desktop or web, request protocol, import format), the app version,
 *   OS and locale, and a random session id that changes every run. Never URLs, names, bodies, headers or variables.
 * - errors: the error message and stack trace of a bug in Dispatch itself, with addresses, e-mails, IPs and tokens
 *   blanked out. No breadcrumbs, no request data, no user id.
 */
import { version } from '../../package.json'
import { isDesktop } from '../core/transport'

const APTABASE_KEY = (import.meta.env.VITE_APTABASE_APP_KEY as string | undefined) ?? ''
const SENTRY_DSN = (import.meta.env.VITE_SENTRY_DSN as string | undefined) ?? ''
/** snapshot (test builds), release, or dev. */
export const CHANNEL = ((import.meta.env.VITE_DISPATCH_CHANNEL as string | undefined) || 'dev') as 'snapshot' | 'release' | 'dev'

const aptabaseHost = (key: string) => ({ EU: 'https://eu.aptabase.com', US: 'https://us.aptabase.com' } as Record<string, string>)[key.split('-')[1] ?? '']

/** Which kinds of sharing this build can do at all. */
export const telemetryAvailable = { usage: !!aptabaseHost(APTABASE_KEY), errors: /^https:\/\/[^@]+@[^/]+\/\d+$/.test(SENTRY_DSN) }
export const telemetryOffered = () => telemetryAvailable.usage || telemetryAvailable.errors

let usageOn = false
let errorsOn = false
const session = `${Math.floor(Date.now() / 1000)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
const platform = () => (isDesktop() ? 'desktop' : 'web')

/** Blanks out anything that could identify a person or an API in an error text. */
export function redact(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)]+/gi, '<url>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b(bearer|basic|token|key|secret|password|pass|pwd)\b([\s:=]+)\S+/gi, '$1$2<hidden>')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '<long-value>')
}

/** Sends one usage event when the person agreed. Props must be fixed labels, never user content. */
export function track(eventName: string, props?: Record<string, string | number | boolean>) {
  if (!usageOn || !telemetryAvailable.usage) return
  void fetch(`${aptabaseHost(APTABASE_KEY)}/api/v0/event`, {
    method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json', 'App-Key': APTABASE_KEY },
    body: JSON.stringify({
      timestamp: new Date().toISOString(), sessionId: session, eventName,
      systemProps: { locale: navigator.language, isDebug: CHANNEL === 'dev', appVersion: version, sdkVersion: `dispatch@${version}` },
      props: { platform: platform(), channel: CHANNEL, ...props },
    }),
  }).catch(() => { /* offline: drop it */ })
}

type SentryEvent = { message?: string; exception?: { values?: { value?: string; stacktrace?: { frames?: { abs_path?: string; filename?: string }[] } }[] }; request?: unknown; user?: unknown; breadcrumbs?: unknown; extra?: unknown }

/** Scrubs a Sentry event before it leaves the device (exported for tests). */
export function scrubEvent<T extends SentryEvent>(e: T): T {
  delete e.request; delete e.user; delete e.breadcrumbs; delete e.extra
  if (e.message) e.message = redact(e.message)
  for (const ex of e.exception?.values ?? []) {
    if (ex.value) ex.value = redact(ex.value)
    // Frames point at Dispatch's own bundled files; keep only the file name.
    for (const f of ex.stacktrace?.frames ?? []) {
      if (f.abs_path) f.abs_path = f.abs_path.replace(/^.*\//, '')
      if (f.filename) f.filename = f.filename.replace(/^.*\//, '')
    }
  }
  return e
}

async function startErrors() {
  const Sentry = await import('@sentry/browser')
  Sentry.init({
    dsn: SENTRY_DSN,
    release: `dispatch@${version}`,
    environment: CHANNEL,
    sendDefaultPii: false,
    // Only uncaught errors: no breadcrumbs (they would hold URLs), no tracing, no session replay.
    defaultIntegrations: false,
    integrations: [Sentry.globalHandlersIntegration(), Sentry.linkedErrorsIntegration(), Sentry.dedupeIntegration()],
    beforeBreadcrumb: () => null,
    beforeSend: (e) => scrubEvent(e as SentryEvent) as typeof e,
  })
  Sentry.setTag('platform', platform())
}

async function stopErrors() {
  const Sentry = await import('@sentry/browser')
  await Sentry.close()
}

/** Applies the person's choices (on start and whenever Settings change). */
export function applyTelemetry(choice: { shareUsage: boolean; shareErrors: boolean }) {
  const startUsage = choice.shareUsage && !usageOn
  usageOn = choice.shareUsage
  if (startUsage) track('app_started')
  const wantErrors = choice.shareErrors && telemetryAvailable.errors
  if (wantErrors && !errorsOn) { errorsOn = true; void startErrors().catch(() => { errorsOn = false }) }
  else if (!wantErrors && errorsOn) { errorsOn = false; void stopErrors() }
}
