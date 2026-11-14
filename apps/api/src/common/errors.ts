import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = 'resource') => new ApiError(404, 'not_found', `${what} not found`);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, 'forbidden', msg);
export const badRequest = (code: string, msg: string) => new ApiError(400, code, msg);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly log = new Logger('Http');

  catch(err: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (res.headersSent) return;
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let headers: Record<string, string> = {};
    if (err instanceof ApiError) {
      ({ status, code, message, headers } = err);
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : 'bad_request';
      message = err.message;
    } else {
      const e = err as { type?: string; status?: number };
      if (e?.type === 'entity.parse.failed') {
        status = 400; code = 'invalid_json'; message = 'Invalid JSON body';
      } else if (e?.type === 'entity.too.large') {
        status = 413; code = 'payload_too_large'; message = 'Payload too large';
      } else {
        this.log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
      }
    }
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).json({ error: { code, message } });
  }
}
