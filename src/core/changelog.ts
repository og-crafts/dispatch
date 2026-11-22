/** Every release's changes, newest first. The same file builds the site's /changelog/ page (site/build.py). */
import data from '../../changelog.json'

export interface Release { version: string; date: string; title: string; changes: string[] }

export const RELEASES: Release[] = data.releases

/** Splits an item into plain text, `code` and **bold** parts (the only markup the changelog uses). */
export function inlineParts(text: string): { kind: 'text' | 'code' | 'bold'; text: string }[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean).map((p) =>
    p.startsWith('`') && p.endsWith('`') && p.length > 1 ? { kind: 'code', text: p.slice(1, -1) }
      : p.startsWith('**') && p.endsWith('**') && p.length > 3 ? { kind: 'bold', text: p.slice(2, -2) }
        : { kind: 'text', text: p })
}
