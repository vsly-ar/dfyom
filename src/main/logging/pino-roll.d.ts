// pino-roll ships no types. Only what ./logger.ts uses is declared (the stream is a SonicBoom).
declare module 'pino-roll' {
  interface PinoRollOptions {
    file: string
    size?: string | number
    extension?: string
    mkdir?: boolean
  }

  export interface RollStream {
    /** Path of the file currently written; null until the first open completes. */
    readonly file: string | null
    write(chunk: string): boolean
    flush(cb?: (err?: Error) => void): void
    flushSync(): void
    end(): void
    on(event: 'ready' | 'close', listener: () => void): this
    on(event: 'error', listener: (err: Error) => void): this
    once(event: 'ready' | 'close' | 'finish', listener: () => void): this
    once(event: 'error', listener: (err: Error) => void): this
  }

  export default function pinoRoll(options: PinoRollOptions): Promise<RollStream>
}
