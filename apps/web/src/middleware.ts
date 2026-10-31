import { NextResponse, type NextRequest } from 'next/server';

/**
 * Records the request path in a header the server components can read.
 *
 * Server Components have no access to the request URL; without this, the
 * (app) layout's requireAuthenticated() cannot know which page an
 * unauthenticated visitor was headed for, and the post-login return path
 * (AUD-21, src/lib/auth/next-path.ts) has nothing to carry. The header is
 * set here, on the request as it enters, so a client cannot inject it: any
 * x-pathname a client sends is overwritten with the real path.
 *
 * The value is used ONLY to build the /login redirect target, and that
 * target is re-validated as a same-origin relative path before use — see
 * safeNextPath(). API routes and static assets are excluded: they never
 * render the (app) layout.
 */
export function middleware(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
