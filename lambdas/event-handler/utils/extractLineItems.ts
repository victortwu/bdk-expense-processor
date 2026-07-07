import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime'
import { BEDROCK_MODEL_ID, BEDROCK_REGION } from '../constants'
import { ExtractionResult } from '../types'

const bedrockClient = new BedrockRuntimeClient({ region: BEDROCK_REGION })

const DEFAULT_EXTRACTION_PROMPT = `From this receipt/invoice, extract the following. Return valid JSON only, no markdown.

1. "grandTotal": the final total amount paid (the single most prominent total on the receipt)
2. "tax": sales tax amount (0 if not shown)
3. "deliveryFee": delivery or shipping fee (0 if not shown)
4. "nonFoodItems": an array of items that are NOT food or ingredients. This includes: cleaning supplies, chemicals, paper products, packaging (containers, bags, wrap, foil), janitorial supplies, equipment, office supplies. For each item provide:
   - "description": item name as shown on receipt
   - "amount": the extended price (qty × unit price) for that item
   - "category": one of "packaging", "janitorial", "other"

Do NOT include food, beverages, or cooking ingredients in nonFoodItems. Only non-food items.

Format:
{
  "grandTotal": 755.69,
  "tax": 42.18,
  "deliveryFee": 0,
  "nonFoodItems": [
    { "description": "Plastic Wrap 18in", "amount": 12.99, "category": "packaging" },
    { "description": "Dawn Dish Soap 1gal x3", "amount": 25.47, "category": "janitorial" }
  ]
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
      maxTokens: 2048,
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

  const outputText = responseBody.output?.message?.content?.[0]?.text || ''

  return parseExtractionResponse(outputText)
}

const parseExtractionResponse = (text: string): ExtractionResult => {
  // Strip markdown code fences if present
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()

  try {
    const parsed = JSON.parse(cleaned)
    return {
      grandTotal: parsed.grandTotal || 0,
      tax: parsed.tax || 0,
      deliveryFee: parsed.deliveryFee || 0,
      nonFoodItems: Array.isArray(parsed.nonFoodItems)
        ? parsed.nonFoodItems.map((item: Record<string, unknown>) => ({
            description: String(item.description || ''),
            amount: Number(item.amount) || 0,
            category: String(item.category || 'other'),
          }))
        : [],
    }
  } catch {
    console.error('Failed to parse Bedrock extraction response:', text)
    return { grandTotal: 0, tax: 0, deliveryFee: 0, nonFoodItems: [] }
  }
}
