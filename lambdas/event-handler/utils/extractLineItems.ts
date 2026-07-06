import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { BEDROCK_MODEL_ID, BEDROCK_REGION } from '../constants'
import { ExtractionResult } from '../types'

const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION })

const DEFAULT_EXTRACTION_PROMPT = `Extract all line items from this receipt/invoice. For each item return: upc (if visible), description, quantity, unitPrice, amount (extended price). Also extract the summary: subtotal, tax, total. Return valid JSON only, no markdown.

Format:
{
  "lineItems": [{ "upc": "...", "description": "...", "quantity": 1, "unitPrice": 5.99, "amount": 5.99 }],
  "subtotal": 100.00,
  "tax": 8.50,
  "total": 108.50
}`

export const extractLineItems = async (
  extractedText: string,
  customPrompt?: string,
): Promise<ExtractionResult> => {
  const systemPrompt = customPrompt || DEFAULT_EXTRACTION_PROMPT

  const payload = {
    messages: [
      {
        role: 'user',
        content: [{ text: `${systemPrompt}\n\n---\n\n${extractedText}` }],
      },
    ],
    inferenceConfig: {
      maxTokens: 4096,
      temperature: 0.1,
    },
  }

  const command = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(payload),
  })

  const response = await bedrockClient.send(command)
  const responseBody = JSON.parse(new TextDecoder().decode(response.body))

  const outputText =
    responseBody.output?.message?.content?.[0]?.text || ''

  return parseExtractionResponse(outputText)
}

const parseExtractionResponse = (text: string): ExtractionResult => {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

  try {
    const parsed = JSON.parse(cleaned) as ExtractionResult
    return {
      lineItems: parsed.lineItems || [],
      subtotal: parsed.subtotal,
      tax: parsed.tax,
      total: parsed.total,
    }
  } catch {
    console.error('Failed to parse Bedrock extraction response:', text)
    return { lineItems: [], subtotal: undefined, tax: undefined, total: undefined }
  }
}
