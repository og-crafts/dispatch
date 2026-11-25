import type { Connection } from '../connections'
import { nativeFetch, type NetSettings } from '../nativeFetch'
import type { Provider } from './types'

/** The provider for a connection. Its code (and the Anthropic SDK) is only loaded here. */
export async function createProvider(conn: Connection, net: NetSettings): Promise<Provider> {
  const f = nativeFetch(conn, net)
  if (conn.kind === 'anthropic') return (await import('./anthropic')).anthropicProvider(conn, f)
  return (await import('./chat')).chatProvider(conn, f)
}
