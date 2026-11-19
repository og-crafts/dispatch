/** Dispatch's version, read from package.json so the CLI and the MCP client never fall behind a release. */
import { version } from '../../package.json'

export const VERSION: string = version
