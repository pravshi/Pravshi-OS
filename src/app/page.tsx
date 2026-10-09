import { redirect } from 'next/navigation';

/**
 * `/` is the post-login landing route (the login flow pushes here). The
 * signed-in home lives at /home inside the (app) shell, so the root route
 * only redirects — unauthenticated visitors are bounced on to /login by
 * the (app) layout's authentication guard.
 */
export default function RootPage() {
  redirect('/home');
}
