import { useEffect, useState } from 'react'
import { ImageIcon } from 'lucide-react'
import { api } from '../../lib/api'
import type { Product } from '../../../shared/catalog'

export function ProductImage({ product }: { product: Pick<Product, 'id' | 'name' | 'image_id'> }) {
  const [image, setImage] = useState<{ key: string; url: string } | null>(null)
  const key = `${product.id}:${product.image_id}`
  useEffect(() => {
    if (!product.image_id) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    void api.productImage(product.id, controller.signal).then((blob) => {
      if (!controller.signal.aborted && blob) {
        objectUrl = URL.createObjectURL(blob)
        setImage({ key, url: objectUrl })
      }
    }).catch(() => { /* A failed optional photo never invents stock or prices. */ })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [key, product.id, product.image_id])
  return image?.key === key ? <img className="product-photo" src={image.url} alt={product.name} loading="lazy" />
    : <span className="product-photo product-photo-placeholder" role="img" aria-label={`Sin fotografía de ${product.name}`}><ImageIcon size={28} /></span>
}
