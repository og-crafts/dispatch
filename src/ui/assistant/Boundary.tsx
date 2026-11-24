import { Component, type ReactNode } from 'react'

/** Shows `fallback` when something inside fails, until `resetKey` changes. */
export class Boundary extends Component<{ fallback: ReactNode; resetKey?: unknown; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidUpdate(before: { resetKey?: unknown }) { if (this.state.failed && before.resetKey !== this.props.resetKey) this.setState({ failed: false }) }
  render() { return this.state.failed ? this.props.fallback : this.props.children }
}
