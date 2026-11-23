/**
 * Layout for the /embed/* routes.
 *
 * The embed frame runs inside a sandboxed <iframe>; this layout strips the
 * full app chrome (network badge, locale switcher, skip-nav link) so the
 * frame's output is as compact as possible. The root layout still provides
 * the <html>/<body> shell and global CSS.
 */

export default function EmbedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // No chrome — just the page content.
  return <>{children}</>;
}
