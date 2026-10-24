import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { asRecord, QuotaError } from '../types';
import { cancelled, protocolError } from './errors';

type Pending = { resolve(value: unknown): void; reject(reason: QuotaError): void };

/**
 * 책임: 한 App Server 프로세스의 JSON-RPC 연결과 요청 수명을 소유한다.
 * 알고리즘: 요청 ID별 Promise와 UTF-8 행 버퍼로 응답·알림을 분배하고, 실패 시 대기 요청을 함께 거절한다.
 */
export class RpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  private failure: QuotaError | null = null;
  private closing = false;
  private closed = false;
  private readonly exited: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly abort: () => void;

  get hasExited(): boolean { return this.closed; }

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly signal: AbortSignal,
    private readonly graceMs: number, private readonly onSnapshot: (value: unknown) => void) {
    this.exited = new Promise(resolve => {
      child.once('close', (code, exitSignal) => {
        this.closed = true;
        if (!this.closing || (code !== 0 && exitSignal === null)) {
          this.fail(new QuotaError('process', { key: 'quota.codexServerExited' }));
        }
        resolve();
      });
    });
    child.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexServerStartFailed' })));
    child.stdin.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexCommunicationClosed' })));
    child.stdout.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexReadFailed' })));
    child.stderr.on('error', () => {});
    // Drain stderr without retaining arbitrary CLI diagnostics (which can contain secrets).
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.abort = () => this.fail(cancelled());
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed || this.closing) return Promise.reject(new QuotaError('process', { key: 'quota.codexConnectionClosed' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure;
    this.write({ method, params });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  /**
   * 책임: 정상 종료·취소·실패 모두에서 자식 프로세스를 회수한다.
   * 알고리즘: 입력을 닫고 종료를 기다린 뒤 유예 시간을 넘으면 SIGTERM·SIGKILL 순으로 종료를 강화하고 스트림을 해제한다.
   */
  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.signal.removeEventListener('abort', this.abort);
    this.rejectPending(cancelled());
    this.child.stdin.end();
    try {
      let stopped = await this.waitExit(this.graceMs);
      if (!stopped) {
        this.child.kill('SIGTERM');
        stopped = await this.waitExit(this.graceMs);
      }
      if (!stopped) {
        this.child.kill('SIGKILL');
        stopped = await this.waitExit(Math.max(1000, this.graceMs));
      }
      if (!stopped) {
        throw new QuotaError('process', { key: 'quota.codexStopFailed' });
      }
      if (this.failure && this.failure.code !== 'cancelled') throw this.failure;
    } finally {
      this.buffered = '';
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, ms));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  /**
   * 책임: stdout 청크를 크기가 제한된 JSON-RPC 메시지로 복원한다.
   * 알고리즘: UTF-8 decoder로 분할 문자를 이어 붙이고 개행마다 JSON을 해석하며, 행 또는 미완성 버퍼가 상한을 넘으면 실패시킨다.
   */
  private consume(chunk: Buffer): void {
    if (this.closing || this.failure) return;
    this.buffered += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffered.indexOf('\n');
      if (newline < 0) break;
      if (newline > 1_048_576) { this.fail(protocolError()); return; }
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(protocolError()); return; }
    }
    if (this.buffered.length > 1_048_576) this.fail(protocolError());
  }

  /**
   * 책임: RPC 응답과 서버 알림을 올바른 소비자에게 전달한다.
   * 알고리즘: ID로 대기 요청을 찾고 상태 코드를 공통 오류로 변환하며, 한도 갱신 알림만 허용하고 서버 실행 요청은 거부한다.
   */
  private receive(value: unknown): void {
    const message = asRecord(value);
    if (!message) throw protocolError();
    if (typeof message.method === 'string') {
      this.handleServerMessage(message);
      return;
    }
    this.handleResponse(message);
  }

  /** 서버 실행 요청은 거부하고 quota 갱신 알림만 전달한다. */
  private handleServerMessage(message: Record<string, unknown>): void {
    if (message.id !== undefined) {
      // A quota read never accepts server-initiated tool execution or login requests.
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      return;
    }
    if (message.method === 'account/rateLimits/updated') this.onSnapshot(message.params);
  }

  /** 일치하는 대기 요청을 제거하고 응답 결과 또는 분류한 오류로 완료한다. */
  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const error = asRecord(message.error);
    if (error) {
      pending.reject(this.parseResponseError(error));
      return;
    }
    if ('result' in message) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(protocolError());
  }

  /** RPC 오류의 상태 코드만 해석하며 서버 오류 본문은 노출하지 않는다. */
  private parseResponseError(error: Record<string, unknown>): QuotaError {
    const data = asRecord(error.data);
    const status = data?.statusCode ?? data?.status ?? error.code;
    switch (status) {
      case 429:
        return new QuotaError('rate-limit', { key: 'quota.codexRateLimited' });
      case 401:
      case 403:
        return new QuotaError('authentication', { key: 'quota.codexSignInAgain' });
      default:
        return new QuotaError('protocol', { key: 'quota.codexRequestFailed' });
    }
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { this.fail(new QuotaError('process', { key: 'quota.codexSendFailed' })); }
  }
  private fail(error: QuotaError): void {
    this.failure ??= error;
    this.rejectPending(this.failure);
  }
  private rejectPending(error: QuotaError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
