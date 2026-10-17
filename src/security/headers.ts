// A14: every response carries `X-Request-Id` (the same id the log lines and the error body carry) and `Cache-Control: no-store` (so that no cache, the browser's or one in front of the API,
// keeps money data), except the photo files (P3), whose route sets its own caching. The standard security headers come from helmet (headers below). This hook runs for every answer: a
// route's, the 404, an error, a preflight, a refused call.
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyHelmetOptions } from '@fastify/helmet';
import { PUBLIC_ROUTES } from '../permissions/matrix.js';

/** The two public photo reads. The website's <img> loads them from another origin of the same site, with no cookie (P3, O11). */
function isPhotoFile(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const url = request.routeOptions?.url;
  return url === PUBLIC_ROUTES['photo-full'].path || url === PUBLIC_ROUTES['photo-thumb'].path;
}

/**
 * onSend: the request id, no-store, and for a photo file that was found (a 2xx or 304) the one exception: no `no-store`, and `Cross-Origin-Resource-Policy: cross-origin` so that the website
 * can show it. A photo that is not found, or any error, is not a photo file and is not cached.
 */
export async function responseHeaders(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  reply.header('X-Request-Id', request.id);
  if (isPhotoFile(request) && (reply.statusCode < 400 || reply.statusCode === 304)) {
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return;
  }
  reply.header('Cache-Control', 'no-store');
}

/**
 * helmet's defaults (Strict-Transport-Security, X-Content-Type-Options: nosniff, Referrer-Policy: no-referrer, X-Frame-Options, Cross-Origin-Opener-Policy and Cross-Origin-Resource-Policy,
 * no X-Powered-By) with a content security policy that suits an API: it serves JSON and images and nothing a browser should run or frame.
 */
export const helmetOptions: FastifyHelmetOptions = {
  global: true,
  contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
};
