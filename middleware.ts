import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  // Опциональная проверка внутреннего ключа доступа для API-роутов.
  // Если INTERNAL_ACCESS_KEY не задан — middleware пропускает все запросы (обратная совместимость).
  const internalKey = process.env.INTERNAL_ACCESS_KEY;
  if (internalKey && request.nextUrl.pathname.startsWith('/api/')) {
    const provided = request.headers.get('X-Internal-Key');
    if (provided !== internalKey) {
      return new NextResponse('Forbidden', { status: 403 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
