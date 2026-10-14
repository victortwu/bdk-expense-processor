/**
 * STAGE 2 — FOCUSED FINANCIAL-INTENT CLASSIFICATION (advisory LLM)
 * ────────────────────────────────────────────────────────────────────────────
 * A single-purpose Bedrock call that classifies the LIFECYCLE STAGE of a
 * financial document (bill | reminder | receipt | statement | unknown) so the
 * deterministic Stage 3 (decideBooking) can decide whether to book to QBO.
 *
 * This is a REAL production module (not test-only) — the event-handler will call
 * it after resolving the vendor and loading the vendor's optional documentProfile.
 * The eval harness (test/integration) exercises this same function against real
 * Textract fixtures.
 *
 * Prompt discipline (per design): single-purpose, bias-to-NOT-book on ambiguity,
 * multi-invoice ⇒ not a single bill. Only the vendor `documentProfile` (intent
 * context) is injected — never booking-mechanics fields.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { BEDROCK_MODEL_ID, BEDROCK_REGION } from '../constants'
import { FinancialIntent, IntentConfidence, IntentResult } from './types'

const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION })

const INTENT_SYSTEM_PROMPT = `You classify the LIFECYCLE STAGE of a financial document for accrual bookkeeping.
Return ONLY valid JSON (no markdown) with exactly these fields:
  financialIntent, invoiceNumber, referencedInvoiceNumbers, intentConfidence, intentRationale

financialIntent definitions:
- bill: an obligation to pay — an invoice/statement of what is OWED. Signals: "amount due",
  "balance", "please remit", "invoice #", "status: open", a due date, a remittance stub.
  THIS is the bookable event.
- reminder: a prompt about an upcoming/scheduled payment that has NOT happened yet. Signals:
  "payment scheduled", "autopay will run", "reminder", "upcoming withdrawal". NOT bookable.
- receipt: confirmation that money has MOVED / a balance was paid. Signals: "payment received",
  "thank you for paying", "has been approved", "payment confirmation", "$0.00 balance", "paid".
  NOT bookable. May reference the invoices it paid (put them in referencedInvoiceNumbers).
- statement: a periodic summary of multiple charges/activity. Informational by default.
- unknown: none of the above clearly fit.

CRITICAL RULES:
- When torn between "bill" and "receipt"/"reminder", choose the NON-bill label. Never over-book.
- A document that references MULTIPLE invoice numbers, or confirms a payment, is NOT a single bill.
- invoiceNumber = the vendor's own invoice/document number for THIS charge, if present; else null.
- referencedInvoiceNumbers = any invoice numbers this document refers to; [] if none or only one.
- intentConfidence: "high" if signals are unambiguous, "medium" if plausible, "low" if guessing.
- A document can simultaneously MENTION autopay enrollment yet still BE a bill if it states an open
  balance/amount due for a specific invoice. Autopay mention alone does not make it a receipt.`

const buildPrompt = (documentProfile?: string): string => {
  if (!documentProfile) return INTENT_SYSTEM_PROMPT
  return `${INTENT_SYSTEM_PROMPT}

Vendor-specific notes for THIS document's sender:
${documentProfile}`
}

export const classifyIntent = async (
  extractedText: string,
  documentProfile?: string,
): Promise<IntentResult> => {
  const payload = {
    system: [{ text: buildPrompt(documentProfile) }],
    messages: [
      {
        role: 'user',
        content: [{ text: `Classify this document and return the JSON object:\n\n${extractedText}` }],
      },
    ],
    inferenceConfig: { maxTokens: 512, temperature: 0 },
  }

  const response = await bedrockClient.send(
    new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    }),
  )

  const responseBody = JSON.parse(new TextDecoder().decode(response.body))
  const outputText = responseBody.output?.message?.content?.[0]?.text || ''
  return parseIntentResponse(outputText)
}

const VALID_INTENTS: FinancialIntent[] = ['bill', 'reminder', 'receipt', 'statement', 'unknown']
const VALID_CONFIDENCE: IntentConfidence[] = ['high', 'medium', 'low']

export const parseIntentResponse = (text: string): IntentResult => {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
  try {
    const p = JSON.parse(cleaned) as Record<string, unknown>
    const intent = VALID_INTENTS.includes(p.financialIntent as FinancialIntent)
      ? (p.financialIntent as FinancialIntent)
      : 'unknown'
    const confidence = VALID_CONFIDENCE.includes(p.intentConfidence as IntentConfidence)
      ? (p.intentConfidence as IntentConfidence)
      : 'low'
    const refs = Array.isArray(p.referencedInvoiceNumbers)
      ? p.referencedInvoiceNumbers.map(String).filter((s) => s && s !== 'null')
      : []
    const invoiceNumber =
      p.invoiceNumber && String(p.invoiceNumber) !== 'null' ? String(p.invoiceNumber) : undefined
    return {
      financialIntent: intent,
      invoiceNumber,
      referencedInvoiceNumbers: refs,
      intentConfidence: confidence,
      intentRationale: p.intentRationale ? String(p.intentRationale) : '',
    }
  } catch {
    // Fail safe: unparseable → unknown/low → Stage 3 routes to needs_review.
    return {
      financialIntent: 'unknown',
      referencedInvoiceNumbers: [],
      intentConfidence: 'low',
      intentRationale: 'unparseable_model_output',
    }
  }
}
