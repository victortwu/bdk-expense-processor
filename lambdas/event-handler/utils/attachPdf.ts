import { attachPdf as sharedAttachPdf } from '../../shared/booking/attachPdf'
import { QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from './getAuthToken'

/**
 * Event-handler PDF attach: thin binding over the shared `attachPdf` primitive
 * with this Lambda's own QBO Service URL + container-cached getAuthToken. The
 * public signature is unchanged `(purchaseId, originalUri) => { success, error? }`
 * so the event-handler's call site + tests are untouched; behaviour is identical.
 */
export const attachPdf = async (
  purchaseId: string,
  originalUri: string,
): Promise<{ success: boolean; error?: string }> =>
  sharedAttachPdf(purchaseId, originalUri, { getAuthToken, qboServiceUrl: QBO_SERVICE_URL })
