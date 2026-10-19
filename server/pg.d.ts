declare module 'pg' {
  export class Pool {
    constructor(options?: Record<string, unknown>);
    query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
    connect(): Promise<{ query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>; release(): void }>;
    end(): Promise<void>;
  }
}
