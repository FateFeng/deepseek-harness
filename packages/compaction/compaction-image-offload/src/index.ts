/**
 * Image offload executor for the compaction seam. When an image-capable route
 * fails a request with `IMAGE_OFFLOAD_REQUIRED`, the plugin records one
 * `image/offload` decision selecting the oldest retained input occurrences
 * and retries through the agent or compaction summary error waterfall. Every route
 * sends placeholder text for those occurrences in subsequent requests.
 *
 * A provider-side size rejection (HTTP 413) means the route's configured image
 * bounds sit above the endpoint's real byte limit, so the request never reached
 * the budget check that would have raised `IMAGE_OFFLOAD_REQUIRED`. The plugin
 * treats that failure as the same repairable condition: it offloads half of the
 * retained occurrences and retries, converging within logarithmically many
 * attempts, and steps aside once nothing remains to offload.
 *
 * @module @deepseek-ai/dsh-compaction-image-offload
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-compaction'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { IMAGE_OFFLOAD_REQUIRED_CODE, isRequestTooLargeError, LlmError } from '@deepseek-ai/dsh-llm'
import { offloadOldestImages, retainedImageCount } from './image-offload.ts'
import { imageOffloadProjection } from './projection.ts'

export const name = 'compaction-image-offload'
export const inject = ['agents', 'sessions']

/**
 * Mount agent and summary recovery listeners without configuration.
 * @param ctx - the plugin context.
 */
export function apply(ctx: Context): void {
  ctx.sessions.registerMessageProjection(imageOffloadProjection)
  ctx.on('agent/request-error', ({ agent, failure, signal }, next): Promise<RequestErrorAction> => {
    if (failure.code === IMAGE_OFFLOAD_REQUIRED_CODE && failure.offloadImages !== undefined && !signal.aborted) {
      // A durable surface repair, not a provider retry: it spends no retry budget and logs no retry event.
      if (!offloadOldestImages(agent.session, agent.session.surface.nodes, failure.offloadImages)) return next()
      return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
    }
    if (failure.code === 'INVALID_REQUEST' && !signal.aborted && isRequestTooLargeError(failure.message)) {
      const retained = retainedImageCount(agent.session, agent.session.surface.nodes)
      if (retained === 0) return next()
      if (!offloadOldestImages(agent.session, agent.session.surface.nodes, Math.ceil(retained / 2))) return next()
      return Promise.resolve<RequestErrorAction>({ kind: 'retry' })
    }
    return next()
  })
  ctx.on('compaction/summary-error', ({ session, sourceEventSeqs, error, signal }, next) => {
    if (!(error instanceof LlmError)
      || error.code !== IMAGE_OFFLOAD_REQUIRED_CODE
      || error.failure.offloadImages === undefined) return next()
    signal?.throwIfAborted()
    if (!offloadOldestImages(session, sourceEventSeqs, error.failure.offloadImages)) return next()
    return true
  })
}
