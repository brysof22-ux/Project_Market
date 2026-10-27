// Colombian formatted input -> canonical decimal string. Never rounds an invalid input.
export function parseCOP(value: string): string | null {
 const text = value.trim()
 let normalized: string
 if (/^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(text)) normalized=text.replaceAll('.','').replace(',','.')
 else if (/^\d+(?:,\d{1,2})?$/.test(text)) normalized=text.replace(',','.')
 else if (/^\d+\.\d{1,2}$/.test(text)) normalized=text
 else return null
 const [whole, fraction=''] = normalized.split('.')
 if (whole.length>14) return null
 return `${BigInt(whole)}.${fraction.padEnd(2,'0')}`
}
export function purchasePreview(quantity: string,total: string,stock: number) {
 const count=Number(quantity), parsed=parseCOP(total)
 const valid=/^\d+$/.test(quantity) && Number.isSafeInteger(count) && count<=1000000 && parsed!==null && (count>0 || Number(parsed)===0)
 return { valid, count, total:parsed, available:valid?stock+count:stock, unit:valid&&count>0?Number(parsed)/count:null }
}
