// Zod schemas of the wire forms of errors and results (worker messages, job and command results).
// Doc: docs/conventions/error-handling/app-error.md#serialization
import { z } from 'zod'
import type { ResultWire } from '../result'
import type { AppErrorData } from './app-error'
import { ERROR_CODES, type ErrorCode } from './codes'

export const ErrorCodeSchema = z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]])

/** `AppError.toJSON()`; `cause` nests (another error, or `{ name, message }`). */
export const AppErrorDataSchema: z.ZodType<AppErrorData> = z
  .object({
    code: ErrorCodeSchema,
    message: z.string(),
    issues: z
      .array(
        z.object({
          path: z.array(z.union([z.string(), z.number()])).readonly(),
          rule: z.string(),
          message: z.string(),
          params: z.record(z.string(), z.unknown()).exactOptional(),
        }),
      )
      .readonly(),
    frames: z
      .array(
        z.object({ where: z.string(), data: z.record(z.string(), z.unknown()).exactOptional() }),
      )
      .readonly(),
    cause: z
      .lazy(() =>
        z.union([AppErrorDataSchema, z.object({ name: z.string(), message: z.string() })]),
      )
      .exactOptional(),
    stack: z.string().exactOptional(),
  })
  .describe('An error (AppErrorData): code, message, issues, context frames')

export const ResultWireSchema: z.ZodType<ResultWire<unknown>> = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }),
  z.object({ ok: z.literal(false), error: AppErrorDataSchema }),
])
