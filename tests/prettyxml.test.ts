import { describe, expect, it } from 'vitest'
import { prettyXml } from '../src/core/format'

describe('prettyXml', () => {
  it('indents elements and keeps short text on its line', () => {
    expect(prettyXml('<?xml version="1.0"?><dogs><dog id="1"><name>Rex</name><tags/><note><![CDATA[a < b]]></note></dog><!-- end --></dogs>')).toBe(
      ['<?xml version="1.0"?>', '<dogs>', '  <dog id="1">', '    <name>Rex</name>', '    <tags/>', '    <note>', '      <![CDATA[a < b]]>', '    </note>', '  </dog>', '  <!-- end -->', '</dogs>'].join('\n'))
  })
  it('keeps empty elements on one line and handles namespaces', () => {
    expect(prettyXml('<s:Envelope xmlns:s="x"><s:Body></s:Body></s:Envelope>')).toBe('<s:Envelope xmlns:s="x">\n  <s:Body></s:Body>\n</s:Envelope>')
  })
  it('gives up on what it can’t lay out safely', () => {
    expect(prettyXml('<a><b></a>')).toBeNull()
    expect(prettyXml('not xml')).toBeNull()
    expect(prettyXml('<a>')).toBeNull()
  })
})
