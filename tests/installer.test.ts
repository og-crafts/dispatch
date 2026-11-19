import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const nsi = readFileSync('src-tauri/installer/installer.nsi', 'utf8')
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'))

/** The Windows installer is Tauri's NSIS template plus our one-click changes; these keep the two in step. */
describe('Windows installer template', () => {
  it('is the template the build uses', () => {
    expect(conf.bundle.windows.nsis.template).toBe('installer/installer.nsi')
  })

  it('was copied from the Tauri CLI version in package.json (re-apply the DISPATCH blocks after a bump)', () => {
    const from = /TAURI-CLI-VERSION: (\S+)/.exec(nsi)?.[1]
    expect(from).toBe(pkg.devDependencies['@tauri-apps/cli'])
  })

  it('turns a plain double-click into a one-click install and opens the app afterwards', () => {
    expect(nsi).toMatch(/GetOptions\} \$CMDLINE "\/WIZARD"/)
    expect(nsi).toMatch(/StrCpy \$PassiveMode 1\s+StrCpy \$OneClick 1/)
    expect(nsi).toMatch(/\$\{ElseIf\} \$OneClick = 1[\s\S]{0,400}?nsis_tauri_utils::RunAsUser "\$INSTDIR/)
  })

  it('leaves silent, passive and update runs as Tauri made them', () => {
    // The updater runs the installer with /P /UPDATE (and /R): none of those may become a one-click install.
    const start = nsi.indexOf('; DISPATCH: one-click install')
    const block = nsi.slice(start, nsi.indexOf('; DISPATCH: end', start))
    expect(block).toMatch(/\$\{IfNot\} \$\{Silent\}/)
    expect(block).toMatch(/\$PassiveMode <> 1/)
    expect(block).toMatch(/\$UpdateMode <> 1/)
    expect(nsi).toMatch(/GetOptions\} \$CMDLINE "\/R" \$R0/)
  })

  it('is plain ASCII, so makensis reads it the same everywhere', () => {
    expect(/[^\x00-\x7F]/.test(nsi)).toBe(false)
  })
  it('hides the wizard buttons only on a one-click run, and keeps Cancel', () => {
    const start = nsi.indexOf('Function OneClickHideWizardButtons')
    const fn = nsi.slice(start, nsi.indexOf('FunctionEnd', start))
    expect(nsi).toContain('!define MUI_PAGE_CUSTOMFUNCTION_SHOW OneClickHideWizardButtons')
    expect(fn).toContain('${If} $OneClick = 1')
    expect(fn).toContain('GetDlgItem $0 $HWNDPARENT 3')
    expect(fn).toContain('GetDlgItem $0 $HWNDPARENT 1')
    expect(fn).not.toContain('$HWNDPARENT 2')
    // while Windows checks a new build before its first start, the window says so
    const done = nsi.slice(nsi.indexOf('Function .onInstSuccess'))
    expect(done.indexOf('"Opening Dispatch"')).toBeGreaterThan(done.indexOf('${ElseIf} $OneClick = 1'))
    expect(done.indexOf('"Opening Dispatch"')).toBeLessThan(done.indexOf('RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" ""'))
  })
})
