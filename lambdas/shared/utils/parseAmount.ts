/** An amount as extracted (e.g. "$2,835.09") or already numeric. */
export type AmountInput = string | number

/** Parse a dollar-formatted string (or number) into a number; unparseable/absent → 0. */
export const parseAmount = (raw: AmountInput | null | undefined): number => {
  if (typeof raw === 'number') return raw
  if (!raw) return 0
  const parsed = parseFloat(raw.replace(/[$,]/g, ''))
  return isNaN(parsed) ? 0 : parsed
}
