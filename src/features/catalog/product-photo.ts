export async function prepareProductImage(file: File): Promise<Blob> {
 if (!['image/png','image/jpeg','image/webp'].includes(file.type) || !file.size || file.size>20*1024*1024) throw new Error('Usa JPG, PNG o WebP de hasta 20 MiB.')
 const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'})
 try {
  if(!bitmap.width||!bitmap.height||bitmap.width*bitmap.height>40_000_000) throw new Error('La imagen supera el límite de 40 megapíxeles.')
  const ratio=Math.min(1,1200/bitmap.width,1500/bitmap.height)
  let width=Math.max(1,Math.round(bitmap.width*ratio)),height=Math.max(1,Math.round(bitmap.height*ratio))
  const canvas=document.createElement('canvas'),context=canvas.getContext('2d')
  if(!context) throw new Error('No se pudo preparar la fotografía.')
  let result:Blob|null=null
  for(let scale=0;scale<4;scale++) {
   canvas.width=width;canvas.height=height
   context.drawImage(bitmap,0,0,width,height)
   for(const quality of [0.8,0.7,0.6,0.5]) {
    result=await new Promise<Blob|null>(resolve=>canvas.toBlob(resolve,'image/webp',quality))
    if(!result||result.type!=='image/webp') throw new Error('Este navegador no permite convertir la fotografía a WebP.')
    if(result.size<200*1024)return result
   }
   if(Math.min(width,height)<400)break
   width=Math.max(1,Math.floor(width*0.85));height=Math.max(1,Math.floor(height*0.85))
  }
  if(!result||result.size>2*1024*1024)throw new Error('No se pudo reducir la fotografía a un tamaño seguro.')
  return result
 } finally {bitmap.close()}
}
