import type { LocalizedMessage } from '../localization';
import { QuotaError, type QuotaProvider, type QuotaProviderId, type QuotaReadContext, type QuotaSnapshot } from './types';

/**
 * 책임: 제공자별 통신 구현과 별개로 모든 조회의 수명과 취소를 소유한다.
 * 알고리즘: 조회 전에 취소 컨트롤러와 Promise를 등록하고 finally로 제거하며, 종료 시 전체 취소 후 완료를 기다린다.
 */
export abstract class BaseQuotaProvider implements QuotaProvider {
  abstract readonly id: QuotaProviderId;
  protected abstract readonly closedMessage: LocalizedMessage;
  private readonly active = new Set<AbortController>();
  private readonly reads = new Set<Promise<QuotaSnapshot>>();
  private closing: Promise<void> | undefined;

  read(context: QuotaReadContext): Promise<QuotaSnapshot> {
    if (this.closing) return Promise.reject(new QuotaError('cancelled', this.closedMessage));

    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    this.active.add(controller);
    // Install ownership before invoking provider code, including synchronous failures.
    const reading = Promise.resolve().then(() =>
      this.readQuota({ ...context, signal })).finally(() => {
      this.active.delete(controller);
      this.reads.delete(reading);
    });
    this.reads.add(reading);
    return reading;
  }

  dispose(): Promise<void> {
    if (!this.closing) {
      this.closing = Promise.resolve().then(async () => {
        await Promise.allSettled(this.reads);
      });

      for (const controller of this.active) controller.abort();
    }
    return this.closing;
  }

  protected abstract readQuota(context: QuotaReadContext): Promise<QuotaSnapshot>;
}
