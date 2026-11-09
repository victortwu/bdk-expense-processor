/**
 * correctAndSubmit handler tests — Path B: direct correct & submit (BDK #3).
 * ────────────────────────────────────────────────────────────────────────────
 * A human books a corrected expense DIRECTLY to QBO, bypassing the intent gate.
 * Routes through the shared `submitCharge` primitive so the CHARGE# dedup marker
 * is written (closes the double-book hole, BDK #2).
 *
 * Covers:
 *  (a) success → books, writes the CHARGE# marker, state → submitted
 *  (b) pre-POST marker hit, no override → 409, NO QBO fetch
 *  (c) marker hit WITH override → proceeds and books
 *  (d) validation failure (bad amount / missing accountRef / missing vendorRef)
 *      → 400, NO QBO fetch
 *  (e) not found → 404
 *
 * Mocks DynamoDB (aws-sdk-client-mock), getAuthToken (jest.mock), global.fetch.
 */
import { mockClient } from 'aws-sdk-client-mock'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb'
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda'
import { installFakeTable } from '../helpers/fakeTable'

process.env.TABLE_NAME = 'test-expense-table'
process.env.QBO_SERVICE_URL = 'https://qbo-service.test'
process.env.COGNITO_TOKEN_URL = 'https://cognito.test/oauth2/token'
process.env.MACHINE_CLIENT_ID = 'test-client-id'
process.env.MACHINE_CLIENT_SECRET = 'test-client-secret'

jest.mock('../../lambdas/shared/auth/getAuthToken', () => ({
  getAuthToken: jest.fn().mockResolvedValue('test-token'),
}))

import { correctAndSubmit } from '../../lambdas/api/handlers/correctAndSubmit'

const ddbMock = mockClient(DynamoDBDocumentClient)
const s3Mock = mockClient(S3Client)
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-west-2' }))

const DOC_ID = '01TESTDOC0000000000000000'

const expenseState = {
  pk: `DOC#${DOC_ID}`,
  sk: 'state',
  documentId: DOC_ID,
  status: 'needs_input',
  needsInputType: 'new_vendor',
  vendorName: 'West Coast Pita',
  vendorDisplay: 'West Coast Pita',
  documentDate: '2025-09-15',
  amounts: ['$553.79'],
  description: 'Food order',
}

const configDefaults = {
  pk: 'CONFIG#defaults',
  sk: 'v0',
  paymentAccountRef: { value: '41', name: 'Visa' },
}

const CHARGE_KEY = 'CHARGE#62#INV#3863817'

const markerItem = {
  pk: CHARGE_KEY,
  sk: 'marker',
  qboPurchaseId: '999',
}

const buildEvent = (body: unknown): APIGatewayProxyEventV2WithJWTAuthorizer =>
  ({
    body: JSON.stringify(body),
    rawPath: `/expenses/${DOC_ID}/correct-and-submit`,
    pathParameters: { documentId: DOC_ID },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer

const mockFetch = (impl: () => Promise<Response>) => {
  global.fetch = jest.fn(impl) as unknown as typeof fetch
}

const okQboResponse = async () =>
  new Response(JSON.stringify({ id: '200', docNumber: 'DOC-200' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** A valid correct-and-submit body with an invoice number (primary charge key). */
const validBody = {
  vendorRef: { value: '62', name: 'West Coast Pita' },
  invoiceNumber: '3863817',
  documentDate: '2025-09-15',
  memo: 'corrected by human',
  lines: [
    {
      accountRef: { value: '1150040000', name: 'Food Purchases - COS' },
      amount: 500,
      description: 'Food',
    },
    { accountRef: { value: '21', name: 'Taxes' }, amount: '$53.79', description: 'Tax' },
  ],
}

beforeEach(() => {
  ddbMock.reset()
  s3Mock.reset()
  jest.clearAllMocks()
})

describe('correctAndSubmit', () => {
  test('(a) success → books multi-line, writes CHARGE# marker, state submitted', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({}) // no existing marker
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({}) // submitCharge writes the marker
    mockFetch(okQboResponse)
    const fetchSpy = global.fetch as jest.Mock

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).purchaseId).toBe('200')
    // booked exactly once
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://qbo-service.test/purchases')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token')
    const payload = JSON.parse(init.body as string)
    // multi-line payload from the human edits
    expect(payload.lines).toHaveLength(2)
    expect(payload.lines[0].amount).toBe(500)
    expect(payload.lines[1].amount).toBe(53.79) // "$53.79" parsed
    expect(payload.entityRef).toEqual({ value: '62', name: 'West Coast Pita' })
    expect(payload.paymentAccountRef).toEqual({ value: '41', name: 'Visa' })
    expect(payload.privateNote).toBe('corrected by human')
    expect(payload.docNumber).toBe(DOC_ID.slice(0, 21))
    // CHARGE# marker written via submitCharge (primary invoice key)
    const markerPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => (c.args[0].input as { Item?: { sk?: string } }).Item?.sk === 'marker')
    expect(markerPuts).toHaveLength(2) // reservation, then the final marker
    const marker = markerPuts[1].args[0].input.Item as Record<string, unknown> | undefined
    expect(marker?.pk).toBe(CHARGE_KEY)
    expect(marker?.qboPurchaseId).toBe('200')
    // state → submitted
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const values = (
      stateUpdate?.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> }
    ).ExpressionAttributeValues
    expect(values?.[':status']).toBe('submitted')
    expect(values?.[':qboPurchaseId']).toBe('200')
    expect(values?.[':needsInputType']).toBeNull()
  })

  test('success persists the human-corrected vendor, date, invoice and booked total on the state', async () => {
    // arrange — correct EVERY field away from what the pipeline extracted
    const correctedKey = 'CHARGE#99#INV#X-1'
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, vendorName: 'unknown', vendorDisplay: undefined } })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: correctedKey, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(okQboResponse)
    const body = {
      ...validBody,
      vendorRef: { value: '99', name: 'Acme Foods' },
      invoiceNumber: 'X-1',
      documentDate: '2025-10-01',
    }

    // act
    const res = await correctAndSubmit(buildEvent(body), ddb)

    // assert
    expect(res.statusCode).toBe(200)
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const input = stateUpdate?.args[0].input as {
      UpdateExpression: string
      ExpressionAttributeValues: Record<string, unknown>
    }
    const set = input.UpdateExpression
    const v = input.ExpressionAttributeValues
    // each attribute is assigned from the matching value (not just present somewhere)
    const assigned = (attr: string) => {
      const key = set.match(new RegExp(`${attr} = (:\\w+)`))?.[1]
      return key ? v[key] : undefined
    }
    expect(assigned('vendorName')).toBe('Acme Foods')
    expect(assigned('vendorDisplay')).toBe('Acme Foods')
    expect(assigned('qboVendorRef')).toEqual({ value: '99', name: 'Acme Foods' })
    expect(assigned('documentDate')).toBe('2025-10-01')
    expect(assigned('invoiceNumber')).toBe('X-1')
    expect(assigned('amounts')).toEqual([553.79])
    // stale failure/skip text must not survive a successful booking
    expect(set).toMatch(/REMOVE #failureReason, #failedAt/)
  })

  test('missing invoice number books under the fallback key and a missing vendor name is rejected', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { sk: 'marker' } }).resolves({}) // fallback-key marker lookup
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(okQboResponse)
    const { invoiceNumber: _omit, ...noInvoice } = validBody

    // act
    const ok = await correctAndSubmit(buildEvent(noInvoice), ddb)
    const noName = await correctAndSubmit(
      buildEvent({ ...validBody, vendorRef: { value: '62' } }),
      ddb,
    )

    // assert
    expect(ok.statusCode).toBe(200)
    const upd = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const vals = (upd?.args[0].input as { ExpressionAttributeValues: Record<string, unknown> })
      .ExpressionAttributeValues
    // no invoice number anywhere → stored as null (clears any stale value)
    expect(vals[':invoiceNumber']).toBeNull()
    expect(noName.statusCode).toBe(400)
    expect(JSON.parse(noName.body).errors).toEqual([
      { field: 'vendorRef.name', message: 'Vendor name is required' },
    ])
  })

  test('(b) pre-POST marker hit, no override → 409, NO QBO fetch', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({ Item: markerItem })
    mockFetch(okQboResponse)

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).qboPurchaseId).toBe('999')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('(c) marker hit WITH override → proceeds and books', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({ Item: markerItem })
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(okQboResponse)

    // act
    const res = await correctAndSubmit(buildEvent({ ...validBody, override: true }), ddb)

    // assert
    expect(res.statusCode).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  test('(d) validation failure → 400, NO QBO fetch', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    mockFetch(okQboResponse)

    // bad amount, missing accountRef, missing vendorRef
    const badBody = {
      documentDate: '2025-09-15',
      lines: [{ accountRef: { value: '', name: '' }, amount: 'not-a-number' }, { amount: -5 }],
    }

    // act
    const res = await correctAndSubmit(buildEvent(badBody), ddb)

    // assert
    expect(res.statusCode).toBe(400)
    const errors = JSON.parse(res.body).errors as Array<{ field: string }>
    const fields = errors.map((e) => e.field)
    expect(fields).toContain('vendorRef.value')
    expect(fields).toContain('lines[0].amount')
    expect(fields).toContain('lines[0].accountRef.value')
    expect(fields).toContain('lines[1].amount')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('(e) not found → 404', async () => {
    // arrange
    ddbMock.on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } }).resolves({}) // no item
    mockFetch(okQboResponse)

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert
    expect(res.statusCode).toBe(404)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('light concurrency guard: stale expectedStatus → 409, NO QBO fetch', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    mockFetch(okQboResponse)

    // act — client thinks it's still "ready" but state is "needs_input"
    const res = await correctAndSubmit(buildEvent({ ...validBody, expectedStatus: 'ready' }), ddb)

    // assert
    expect(res.statusCode).toBe(409)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  // ─── BDK #6 — error-handling hardening ───────────────────────────────────

  test('(case 5) QBO 401 → 502 QBO_AUTH_EXPIRED (actionable), state failed', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({}) // no marker
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    // QBO Service returns 401 (OAuth connection expired) with an intuit_tid header
    mockFetch(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'QBO_AUTH_EXPIRED', message: 'QBO connection expired' },
          }),
          { status: 401, headers: { intuit_tid: 'tid-xyz' } },
        ),
    )

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert: actionable auth-expired error, not a generic 502 message
    expect(res.statusCode).toBe(502)
    const parsed = JSON.parse(res.body)
    expect(parsed.error).toBe('QBO_AUTH_EXPIRED')
    expect(parsed.intuitTid).toBe('tid-xyz')
    // state → failed (no marker written on a failed booking)
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const values = (
      stateUpdate?.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> }
    ).ExpressionAttributeValues
    expect(values?.[':status']).toBe('failed')
    // a failed booking never leaves a booked marker (the reservation is released)
    const bookedMarker = ddbMock
      .commandCalls(PutCommand)
      .find((c) => (c.args[0].input as { Item?: { qboPurchaseId?: string } }).Item?.qboPurchaseId)
    expect(bookedMarker).toBeUndefined()
  })

  test('(case 5) bare 401 WITHOUT QBO_AUTH_EXPIRED code (e.g. gateway rejects our token) → generic 502', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(
      async () => new Response(JSON.stringify({ message: 'Unauthorized' }), { status: 401 }),
    )

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBeUndefined()
    expect(JSON.parse(res.body).message).toContain('QBO submission failed')
  })

  test('(case 5) non-401 QBO failure → generic 502 (no QBO_AUTH_EXPIRED)', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: expenseState })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(async () => new Response('server boom', { status: 500 }))

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert: generic 502, NOT the actionable auth error
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body).error).toBeUndefined()
    expect(JSON.parse(res.body).message).toContain('QBO submission failed')
  })

  // ─── BDK #6 case 4 — un-skip gate ────────────────────────────────────────

  test('(case 4) skipped record without override → 409 SKIPPED_REQUIRES_OVERRIDE, NO QBO fetch', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, status: 'skipped' } })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    mockFetch(okQboResponse)

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('SKIPPED_REQUIRES_OVERRIDE')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('(case 4) skipped record WITH override → proceeds and books', async () => {
    // arrange
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, status: 'skipped' } })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    mockFetch(okQboResponse)

    // act
    const res = await correctAndSubmit(buildEvent({ ...validBody, override: true }), ddb)

    // assert: un-skip allowed via explicit override → booked
    expect(res.statusCode).toBe(200)
    expect(global.fetch).toHaveBeenCalledTimes(1)
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const values = (
      stateUpdate?.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> }
    ).ExpressionAttributeValues
    expect(values?.[':status']).toBe('submitted')
  })

  // ─── Rebook / adopt (state-consistency audit) ────────────────────────────

  test('submitted expense without override → 409 ALREADY_SUBMITTED, NO QBO fetch', async () => {
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, status: 'submitted', qboPurchaseId: 'P-OLD' } })
    mockFetch(okQboResponse)

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(409)
    // HEAD wire contract: the FE reads qboPurchaseId as "already booked" (override offer).
    expect(JSON.parse(res.body)).toEqual({
      message: 'Expense already submitted to QBO — set override to rebook',
      qboPurchaseId: 'P-OLD',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('skipped without override → 409 SKIPPED_REQUIRES_OVERRIDE body unchanged', async () => {
    installFakeTable(ddbMock, [{ ...expenseState, status: 'skipped' }, configDefaults])
    mockFetch(okQboResponse)

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      message: 'This expense was skipped — set override to book it anyway',
      error: 'SKIPPED_REQUIRES_OVERRIDE',
      currentStatus: 'skipped',
    })
  })

  test('fresh in-flight reservation → 409 BOOKING_IN_PROGRESS, no qboPurchaseId (not an override offer)', async () => {
    installFakeTable(ddbMock, [
      expenseState,
      configDefaults,
      {
        pk: CHARGE_KEY,
        sk: 'marker',
        documentId: 'OTHER',
        reservedAt: new Date().toISOString(),
      },
    ])
    mockFetch(okQboResponse)

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body).toEqual({
      message: 'This charge is already being booked — try again shortly',
      error: 'BOOKING_IN_PROGRESS',
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('booked marker for another document → 409 {message, qboPurchaseId}', async () => {
    installFakeTable(ddbMock, [
      expenseState,
      configDefaults,
      { pk: CHARGE_KEY, sk: 'marker', documentId: 'OTHER', qboPurchaseId: '999' },
    ])
    mockFetch(okQboResponse)

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toEqual({
      message: 'Looks already booked as purchase 999',
      qboPurchaseId: '999',
    })
  })

  test('conflict (QBO booked, expense skipped meanwhile) → 409 STATE_CONFLICT, NOT an already-booked offer', async () => {
    const table = installFakeTable(ddbMock, [expenseState, configDefaults])
    mockFetch(async () => {
      table.put({ ...table.get(`DOC#${DOC_ID}`, 'state')!, status: 'skipped' })
      return okQboResponse()
    })

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(409)
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ error: 'STATE_CONFLICT', purchaseId: '200' })
    expect(body).not.toHaveProperty('qboPurchaseId')
    expect(body.message).toContain('Booked in QBO as purchase 200')
  })

  test('an explicit empty invoiceNumber clears the stored one (fallback charge key)', async () => {
    const table = installFakeTable(ddbMock, [
      { ...expenseState, invoiceNumber: 'WRONG-1' },
      configDefaults,
    ])
    mockFetch(okQboResponse)

    const res = await correctAndSubmit(buildEvent({ ...validBody, invoiceNumber: '' }), ddb)

    expect(res.statusCode).toBe(200)
    expect(table.get(`DOC#${DOC_ID}`, 'state')).toMatchObject({
      invoiceNumber: null,
      chargeKey: 'CHARGE#62#AMT#553.79#2025-09-15',
    })
  })

  test('QBO 409 duplicate on an unbooked expense → adopted: 200 linked to the EXISTING purchase', async () => {
    const table = installFakeTable(ddbMock, [expenseState, configDefaults])
    mockFetch(
      async () =>
        new Response(JSON.stringify({ existing: { id: 'P-EXIST', docNumber: 'D-EX' } }), {
          status: 409,
        }),
    )

    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ purchaseId: 'P-EXIST' })
    expect(JSON.parse(res.body).message).toContain('already existed in QBO')
    expect(table.get(`DOC#${DOC_ID}`, 'state')).toMatchObject({
      status: 'submitted',
      qboPurchaseId: 'P-EXIST',
      vendorName: 'West Coast Pita',
      invoiceNumber: '3863817',
      chargeKey: CHARGE_KEY,
    })
  })

  test('concurrent identical submits → one QBO purchase, the other gets 409', async () => {
    installFakeTable(ddbMock, [expenseState, configDefaults])
    mockFetch(okQboResponse)

    const [a, b] = await Promise.all([
      correctAndSubmit(buildEvent(validBody), ddb),
      correctAndSubmit(buildEvent(validBody), ddb),
    ])

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  // ─── BDK #7 — manual-path PDF attachment ─────────────────────────────────

  test('with originalUri on state → attaches PDF best-effort after booking', async () => {
    // arrange
    const ORIGINAL_URI = 's3://processed-bucket/documents/t/doc/original.pdf'
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, originalUri: ORIGINAL_URI } })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    } as never)
    const fetchSpy = jest.fn(async (url: string) => {
      if (String(url).endsWith('/attachments')) {
        return new Response('{}', { status: 200 })
      }
      return new Response(JSON.stringify({ id: '200', docNumber: 'DOC-200' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert: booked + attachment POSTed, state records attachmentUploaded
    expect(res.statusCode).toBe(200)
    const attachCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith('/attachments'))
    expect(attachCall).toBeDefined()
    expect(attachCall?.[0]).toBe('https://qbo-service.test/purchases/200/attachments')
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const values = (
      stateUpdate?.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> }
    ).ExpressionAttributeValues
    expect(values?.[':status']).toBe('submitted')
    expect(values?.[':attachmentUploaded']).toBe(true)
  })

  test('attach failure does NOT fail the booking (submitted + attachmentFailed)', async () => {
    // arrange: attachments POST non-2xx → attach fails, booking must stand
    const ORIGINAL_URI = 's3://processed-bucket/documents/t/doc/original.pdf'
    ddbMock
      .on(GetCommand, { Key: { pk: `DOC#${DOC_ID}`, sk: 'state' } })
      .resolves({ Item: { ...expenseState, originalUri: ORIGINAL_URI } })
    ddbMock
      .on(GetCommand, { Key: { pk: 'CONFIG#defaults', sk: 'v0' } })
      .resolves({ Item: configDefaults })
    ddbMock.on(GetCommand, { Key: { pk: CHARGE_KEY, sk: 'marker' } }).resolves({})
    ddbMock.on(UpdateCommand).resolves({})
    ddbMock.on(PutCommand).resolves({})
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    } as never)
    const fetchSpy = jest.fn(async (url: string) => {
      if (String(url).endsWith('/attachments')) {
        return new Response('attach boom', { status: 500 })
      }
      return new Response(JSON.stringify({ id: '200', docNumber: 'DOC-200' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    global.fetch = fetchSpy as unknown as typeof fetch

    // act
    const res = await correctAndSubmit(buildEvent(validBody), ddb)

    // assert: booking succeeded; attachment flagged failed, not rolled back
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).attachmentFailed).toBe(true)
    const stateUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => (c.args[0].input as { Key?: { pk?: string } }).Key?.pk === `DOC#${DOC_ID}`)
    const values = (
      stateUpdate?.args[0].input as { ExpressionAttributeValues?: Record<string, unknown> }
    ).ExpressionAttributeValues
    expect(values?.[':status']).toBe('submitted')
    expect(values?.[':attachmentFailed']).toBe(true)
  })
})
