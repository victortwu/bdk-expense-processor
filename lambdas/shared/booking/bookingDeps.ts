import { getAuthToken } from '../auth/getAuthToken'
import { QBO_SERVICE_URL, TABLE_NAME } from '../config'
import { attachPdf } from './attachPdf'
import { SubmitChargeDeps } from './submitCharge'

/**
 * The standard booking dependencies for any Lambda that books to QBO: container-cached auth,
 * this Lambda's QBO Service URL / table (from its environment), and the PDF attach binding.
 * The single place `getAuthToken` + `attachPdf` are wired together.
 */
export const getBookingDeps = (): SubmitChargeDeps => {
  return {
    getAuthToken,
    qboServiceUrl: QBO_SERVICE_URL,
    tableName: TABLE_NAME,
    attachPdf: (purchaseId, originalUri) =>
      attachPdf(purchaseId, originalUri, { getAuthToken, qboServiceUrl: QBO_SERVICE_URL }),
  }
}
