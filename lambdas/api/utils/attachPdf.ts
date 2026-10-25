import { attachPdf as sharedAttachPdf } from '../../shared/booking/attachPdf'
import { QBO_SERVICE_URL } from '../constants'
import { getAuthToken } from './getAuthToken'

/**
 * API-Lambda PDF attach: thin binding over the shared `attachPdf` primitive with
 * this Lambda's own QBO Service URL + container-cached getAuthToken. Shape matches
 * the `SubmitChargeDeps.attachPdf` signature `(purchaseId, originalUri) => { success, error? }`
 * so it can be injected directly into `submitCharge` by the manual booking
 * handlers (setAccount / correctAndSubmit — BDK #7). Behaviour is identical to the
 * event-handler's attach.
 */
export const attachPdf = async (
  purchaseId: string,
  originalUri: string,
): Promise<{ success: boolean; error?: string }> =>
  sharedAttachPdf(purchaseId, originalUri, { getAuthToken, qboServiceUrl: QBO_SERVICE_URL })
