/**
 * CHARGE# dedup markers (pk=chargeKey, sk='marker').
 *
 * A marker has two phases: a RESERVATION (no `qboPurchaseId`, written atomically BEFORE the
 * QBO POST so concurrent bookings of the same charge cannot both POST) and the FINAL marker
 * (carries the purchase id). Readers that only care about booked charges check `qboPurchaseId`.
 */
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import { markerKey } from '../keys'
import { logger } from '../utils/logger'

/**
 * A reservation older than this is presumed orphaned (crashed Lambda) and may be taken over.
 * Must stay well above the longest booking Lambda timeout (event handler: 60s) so a slow but
 * live booker is never overtaken. The ONLY place this TTL is applied: `reserveCharge`'s
 * condition and `isBlockingMarker` both derive from `reservationCutoff`.
 */
// Must stay well above the Lambda timeouts (30s API / 60s event) and well BELOW the SQS
// visibility timeout (300s), so a redelivered message finds a crashed reservation already stale.
const RESERVATION_TTL_MS = 2 * 60 * 1000

const reservationCutoff = (now: number): string => new Date(now - RESERVATION_TTL_MS).toISOString()

export interface ChargeMarker {
  pk: string
  sk: 'marker'
  documentId: string
  qboPurchaseId?: string
  vendorId?: string
  invoiceNumber?: string
  amount?: number
  documentDate?: string
  bookedAt?: string
  reservedAt?: string
}

const isConditionalFailure = (err: unknown): boolean =>
  (err as { name?: string })?.name === 'ConditionalCheckFailedException'

export const getMarker = async (
  ddb: DynamoDBDocumentClient,
  tableName: string,
  charge: string,
): Promise<ChargeMarker | undefined> => {
  const { Item } = await ddb.send(new GetCommand({ TableName: tableName, Key: markerKey(charge) }))
  return Item as ChargeMarker | undefined
}

/** A marker blocks a new booking when it records a purchase or is a still-fresh reservation. */
export const isBlockingMarker = (marker: ChargeMarker, now = Date.now()): boolean =>
  !!marker.qboPurchaseId || (marker.reservedAt ?? '') >= reservationCutoff(now)

export type Reservation = { reserved: true } | { reserved: false; existing?: ChargeMarker }

/** Atomically claim a charge key before booking. */
export const reserveCharge = async (
  ddb: DynamoDBDocumentClient,
  tableName: string,
  charge: string,
  documentId: string,
): Promise<Reservation> => {
  const now = Date.now()
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: { ...markerKey(charge), documentId, reservedAt: new Date(now).toISOString() },
        ConditionExpression:
          'attribute_not_exists(pk) OR (attribute_not_exists(qboPurchaseId) AND reservedAt < :stale)',
        ExpressionAttributeValues: { ':stale': reservationCutoff(now) },
      }),
    )
    return { reserved: true }
  } catch (err) {
    if (!isConditionalFailure(err)) throw err
    return { reserved: false, existing: await getMarker(ddb, tableName, charge) }
  }
}

/**
 * Write the final marker. Overwrites an unfinished reservation but never an already-booked
 * marker (a re-book never clobbers the original purchase id).
 */
export const finalizeMarker = async (
  ddb: DynamoDBDocumentClient,
  tableName: string,
  marker: ChargeMarker,
): Promise<void> => {
  try {
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: marker,
        ConditionExpression: 'attribute_not_exists(pk) OR attribute_not_exists(qboPurchaseId)',
      }),
    )
  } catch (err) {
    if (!isConditionalFailure(err)) throw err
    logger.info('Charge marker already exists (not overwritten)', { chargeKey: marker.pk })
  }
}

/** Drop OUR unfinished reservation after a failed booking. Never throws. */
export const releaseReservation = async (
  ddb: DynamoDBDocumentClient,
  tableName: string,
  charge: string,
  documentId: string,
): Promise<void> => {
  try {
    await ddb.send(
      new DeleteCommand({
        TableName: tableName,
        Key: markerKey(charge),
        ConditionExpression: 'documentId = :doc AND attribute_not_exists(qboPurchaseId)',
        ExpressionAttributeValues: { ':doc': documentId },
      }),
    )
  } catch (err) {
    if (!isConditionalFailure(err)) {
      logger.warn('Failed to release charge reservation', { chargeKey: charge, error: String(err) })
    }
  }
}
