// Security headers for every route (SECURITY.md: no debug in prod, CORS allowlist, deny framing).
// The CSP has no 'unsafe-eval'; Next needs 'unsafe-inline' for its inline bootstrap until nonces land with the BFF.
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

/** @type {import('next').NextConfig} */
export default {
  // The demo panel (hito 600, `pnpm demo web`) builds into its own folder so it never replaces the
  // build a local panel is serving from .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  images: { unoptimized: true }, // no sharp (LGPL libvips); see pnpm-workspace.yaml
  reactStrictMode: true,
  transpilePackages: ["@aurea/tokens"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};
