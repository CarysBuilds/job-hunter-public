import type { NextFunction, Request, Response } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function isLoopbackAddress(raw: string | undefined): boolean {
  if (!raw) return false;
  const address = raw.split('%')[0].toLowerCase();
  if (address === '::1' || address === '127.0.0.1') return true;
  return address.startsWith('::ffff:') && address.slice(7) === '127.0.0.1';
}

function hostname(req: Request): string | undefined {
  const host = req.get('host');
  if (!host) return undefined;
  try { return new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return undefined; }
}

function sameOrigin(req: Request, origin: string): boolean {
  try { return new URL(origin).host === req.get('host'); } catch { return false; }
}

export function setSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'none'",
    "form-action 'self'", "connect-src 'self'", "img-src 'self' data:", "style-src 'self'", "script-src 'self'",
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

export function requireLocalAccess(req: Request, res: Response, next: NextFunction): void {
  if (!isLoopbackAddress(req.socket.remoteAddress) || !LOOPBACK_HOSTS.has(hostname(req) ?? '')) {
    res.status(403).json({ ok: false, error: '仅允许从本机访问 Job Hunter' });
    return;
  }
  const isApi = req.path === '/api' || req.path.startsWith('/api/');
  if (!isApi && SAFE_METHODS.has(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ ok: false, error: '拒绝跨站访问 Job Hunter' });
    return;
  }
  const origin = req.get('origin');
  if (origin && !sameOrigin(req, origin)) {
    res.status(403).json({ ok: false, error: '请求来源与 Job Hunter 不一致' });
    return;
  }
  next();
}

export function requireMutationMarker(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.get('x-job-hunter-request') !== '1') {
    res.status(403).json({ ok: false, error: '缺少本机页面请求标记' });
    return;
  }
  next();
}
