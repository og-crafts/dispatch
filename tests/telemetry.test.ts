/** Opt-in usage and error reports: nothing leaves without consent, and what leaves carries no user data. */
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules() })

async function load(keys = true) {
  vi.resetModules(); vi.unstubAllEnvs()
  if (keys) { vi.stubEnv('VITE_APTABASE_APP_KEY', 'A-EU-1234567890'); vi.stubEnv('VITE_SENTRY_DSN', 'https://abc@o1.ingest.de.sentry.io/42') }
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  return { t: await import('../src/ui/telemetry'), fetch }
}

describe('redact', () => {
  it('blanks addresses, e-mails, IPs, JWTs, tokens and long values', async () => {
    const { t } = await load(false)
    expect(t.redact('token eyJhbGciOi.eyJzdWIi.sig')).toBe('token <hidden>')
    expect(t.redact('saw eyJhbGciOi.eyJzdWIi.sig')).toBe('saw <jwt>')
    const out = t.redact('GET https://api.acme.internal/users/7?key=1 failed for ann@acme.com from 10.0.0.12:8080 Bearer eyJhbGciOi.eyJzdWIi.sig password=hunter2 ' + 'x'.repeat(40))
    expect(out).toBe('GET <url> failed for <email> from <ip> Bearer <hidden> password=<hidden> <long-value>')
  })
})

describe('scrubEvent', () => {
  it('drops request, user, breadcrumbs and extra, and keeps only file names in frames', async () => {
    const { t } = await load(false)
    const e = t.scrubEvent({
      message: 'Failed https://x.test', request: { url: 'https://x.test' }, user: { ip: '1.2.3.4' }, breadcrumbs: [{}], extra: { a: 1 },
      exception: { values: [{ value: 'Cannot read https://y.test/a', stacktrace: { frames: [{ abs_path: 'http://tauri.localhost/assets/index-abc.js', filename: 'http://tauri.localhost/assets/index-abc.js' }] } }] },
    })
    expect(e).toEqual({ message: 'Failed <url>', exception: { values: [{ value: 'Cannot read <url>', stacktrace: { frames: [{ abs_path: 'index-abc.js', filename: 'index-abc.js' }] } }] } })
  })
})

describe('usage events', () => {
  it('sends nothing without consent, or in a build without keys', async () => {
    let { t, fetch } = await load(true)
    t.track('request_sent', { protocol: 'http' })
    t.applyTelemetry({ shareUsage: false, shareErrors: false })
    t.track('request_sent', { protocol: 'http' })
    expect(fetch).not.toHaveBeenCalled()
    ;({ t, fetch } = await load(false))
    expect(t.telemetryOffered()).toBe(false)
    t.applyTelemetry({ shareUsage: true, shareErrors: false })
    t.track('request_sent', { protocol: 'http' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('after consent, sends the event name, fixed labels and app facts to Aptabase', async () => {
    const { t, fetch } = await load(true)
    expect(t.telemetryAvailable).toEqual({ usage: true, errors: true })
    t.applyTelemetry({ shareUsage: true, shareErrors: false })
    t.track('request_sent', { protocol: 'grpc' })
    expect(fetch).toHaveBeenCalledTimes(2) // app_started, then the event
    const [url, init] = fetch.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://eu.aptabase.com/api/v0/event')
    expect((init.headers as Record<string, string>)['App-Key']).toBe('A-EU-1234567890')
    const body = JSON.parse(String(init.body))
    expect(body.eventName).toBe('request_sent')
    expect(body.props).toEqual({ platform: 'web', channel: 'dev', protocol: 'grpc' })
    expect(Object.keys(body.systemProps).sort()).toEqual(['appVersion', 'isDebug', 'locale', 'sdkVersion'])
    expect(init.credentials).toBe('omit')
  })
})

describe('feedback', () => {
  it('builds the message with optional version details', async () => {
    vi.resetModules()
    const { feedbackBody } = await import('../src/ui/PrivacyDialogs')
    expect(feedbackBody('idea', '  Dark mode for docs  ', false)).toBe('An idea\n\nDark mode for docs')
    expect(feedbackBody('problem', 'Crash', true, 'UA/1')).toMatch(/^Something doesn’t work\n\nCrash\n\n---\nDispatch \d+\.\d+\.\d+ \(dev\), web app\nUA\/1$/)
  })
})
