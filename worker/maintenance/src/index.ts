export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': 'application/json; charset=utf-8',
    })

    if (url.pathname === '/health' && request.method === 'GET') {
      return Response.json(
        { status: 'maintenance' },
        { status: 200, headers }
      )
    }

    headers.set('Retry-After', '300')

    return Response.json(
      {
        error: {
          code: 'SERVICE_MAINTENANCE',
          message: 'CAI Market esta en mantenimiento por actualizacion. Intenta nuevamente en unos minutos.',
        },
      },
      { status: 503, headers }
    )
  },
}
