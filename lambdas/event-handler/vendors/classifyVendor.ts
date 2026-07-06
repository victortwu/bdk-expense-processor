import { ORDERGOODS_API_URL } from '../constants'
import { OrderGoodsProduct } from '../types'

export interface VendorClassification {
  isMultiLine: boolean
  products: OrderGoodsProduct[]
}

export const classifyVendor = async (vendorName: string): Promise<VendorClassification> => {
  if (!ORDERGOODS_API_URL) {
    return { isMultiLine: false, products: [] }
  }

  try {
    const response = await fetch(
      `${ORDERGOODS_API_URL}/products?vendor=${encodeURIComponent(vendorName)}`,
    )

    if (!response.ok) {
      console.error(`OrderGoods API error: ${response.status}`)
      return { isMultiLine: false, products: [] }
    }

    const data = (await response.json()) as { products: OrderGoodsProduct[] }
    const products = data.products || []

    return {
      isMultiLine: products.length > 0,
      products,
    }
  } catch (err) {
    console.error('Error calling OrderGoods API:', err)
    // Graceful degradation — treat as simple vendor if OrderGoods is unavailable
    return { isMultiLine: false, products: [] }
  }
}
