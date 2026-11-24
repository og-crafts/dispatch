import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react'
import { Boundary } from './Boundary'
import { useConnections } from './store'

const AssistantHost = lazy(() => import('./AssistantHost').then((m) => ({ default: m.AssistantHost })))

/** Loads the assistant once there is a connection; without one there is nothing of it here. */
export function AssistantGate(props: ComponentProps<typeof AssistantHost>) {
  const some = !!useConnections()?.length
  const [used, setUsed] = useState(false)
  useEffect(() => { if (some) setUsed(true) }, [some])
  return some || used ? <Boundary fallback={null}><Suspense fallback={null}><AssistantHost {...props} /></Suspense></Boundary> : null
}
