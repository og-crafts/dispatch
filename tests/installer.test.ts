import { existsSync, readFileSync } from 'node:fs'
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
  it('shows a borderless splash only on a one-click run, with logo files for each scaling', () => {
    const start = nsi.indexOf('Function OneClickSplash')
    const fn = nsi.slice(start, nsi.indexOf('FunctionEnd', start))
    expect(nsi).toContain('!define MUI_PAGE_CUSTOMFUNCTION_SHOW OneClickSplash')
    expect(fn.indexOf('${If} $OneClick <> 1')).toBeLessThan(fn.indexOf('Return')) // other runs keep Tauri's window
    expect(fn.indexOf('Return')).toBeLessThan(fn.indexOf('SetWindowLongW'))
    expect(fn).toContain('IntOp $0 $0 | 0x80000000') // WS_POPUP: no title bar or frame
    expect(fn).toContain('GetDlgItem $7 $9 1004') // the progress bar stays
    for (const pct of [100, 125, 150, 200]) {
      expect(fn).toContain(`splash-logo-${pct}.bmp`)
      expect(existsSync(`src-tauri/installer/splash-logo-${pct}.bmp`)).toBe(true)
    }
    // while Windows checks a new build before its first start, the window says so
    const done = nsi.slice(nsi.indexOf('Function .onInstSuccess'))
    expect(done.indexOf('Opening Dispatch')).toBeGreaterThan(done.indexOf('${ElseIf} $OneClick = 1'))
    const opening = done.slice(done.indexOf('${ElseIf} $OneClick = 1'), done.indexOf('Opening Dispatch'))
    for (const id of [1, 2, 3]) expect(opening).toContain(`GetDlgItem $0 $HWNDPARENT ${id}`) // no buttons come back
    expect(done.indexOf('Opening Dispatch')).toBeLessThan(done.indexOf('RunAsUser "$INSTDIR\\${MAINBINARYNAME}.exe" ""'))
  })
})
