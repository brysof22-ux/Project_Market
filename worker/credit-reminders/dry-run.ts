/** Safe integration scaffold. No fetch(), Meta SDK, token or live transport. */
export type Dispatch = {
  status: string
  dispatch_token?: string
  amount?: string
  phone_e164?: string
  as_of?: string
}

export interface ReminderRepository {
  enqueue(at: string): Promise<number>
  claim(at: string): Promise<Dispatch | null>
  preflight(token: string, at: string): Promise<Dispatch | null>
  finish(
    token: string,
    outcome: 'accepted',
    messageId: string,
    at: string,
  ): Promise<string>
}

export class MockWhatsAppTransport {
  readonly provider = 'mock' as const
  readonly messages = new Map<
    string,
    { amount: string; phone: string; asOf: string }
  >()

  async send(dispatch: Dispatch) {
    if (
      !dispatch.dispatch_token ||
      !dispatch.amount ||
      !dispatch.phone_e164 ||
      !dispatch.as_of
    ) {
      throw new Error('INVALID_MOCK_DISPATCH')
    }
    // Only an in-memory test sink, deliberately not a Meta network adapter.
    this.messages.set(dispatch.dispatch_token, {
      amount: dispatch.amount,
      phone: dispatch.phone_e164,
      asOf: dispatch.as_of,
    })
    return `mock:${dispatch.dispatch_token}`
  }
}

export async function runDryRunBatch(
  repository: ReminderRepository,
  transport: MockWhatsAppTransport,
  now: () => Date = () => new Date(),
  batchSize = 50,
) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error('INVALID_BATCH_SIZE')
  const queued = await repository.enqueue(now().toISOString())
  let simulated = 0
  let skipped = 0
  for (let i = 0; i < batchSize; i++) {
    const reservation = await repository.claim(now().toISOString())
    if (!reservation) break
    if (reservation.status !== 'dispatching' || !reservation.dispatch_token) {
      skipped++
      continue
    }
    const fresh = await repository.preflight(
      reservation.dispatch_token,
      now().toISOString(),
    )
    if (!fresh || fresh.status !== 'dispatching') {
      skipped++
      continue
    }
    const messageId = await transport.send(fresh)
    await repository.finish(
      reservation.dispatch_token,
      'accepted',
      messageId,
      now().toISOString(),
    )
    simulated++
  }
  return { mode: 'dry-run' as const, queued, simulated, skipped }
}

/** Dependency-injected scheduled handler; SQL adapter/Worker deployment is a later step. */
export function createDryRunScheduledHandler(repository: ReminderRepository) {
  const transport = new MockWhatsAppTransport()
  return {
    async scheduled() {
      return runDryRunBatch(repository, transport)
    },
  }
}
