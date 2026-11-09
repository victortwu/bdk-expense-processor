import { QboPayload, ParsedLine } from '../expense/types'
import { QboRef } from '../qbo/types'

/** The purchase payload every human-driven booking (set-account, correct-and-submit) sends. */
export const buildQboPayload = (p: {
  documentId: string
  documentDate: string
  paymentAccountRef: QboRef
  vendorRef: QboRef
  lines: ParsedLine[]
  privateNote: string
}): QboPayload => ({
  docNumber: p.documentId.slice(0, 21),
  txnDate: p.documentDate,
  paymentType: 'CreditCard',
  paymentAccountRef: p.paymentAccountRef,
  entityRef: p.vendorRef,
  lines: p.lines,
  privateNote: p.privateNote,
})
