// quota 제공자의 조회·취소·종료에 필요한 공통 수명을 관리한다.
import type { LocalizedMessage } from '../localization';
import { QuotaError, type QuotaProvider, type QuotaProviderId, type QuotaReadContext, type QuotaSnapshot } from './types';

/** 제공자별 통신 구현과 별개로 진행 중 조회의 등록·취소·종료를 관리한다. */
export abstract class BaseQuotaProvider implements QuotaProvider {
  abstract readonly id: QuotaProviderId;
  protected abstract readonly closedMessage: LocalizedMessage;
  private readonly active = new Set<AbortController>();
  private readonly reads = new Set<Promise<QuotaSnapshot>>();
  private closing: Promise<void> | undefined;

  read(context: QuotaReadContext): Promise<QuotaSnapshot> {
    // [취소 정책] 종료가 시작되면 새 조회를 거절하고 활성 조회에는 호출자·종료 신호를 함께 전달한다.
    if (this.closing) return Promise.reject(new QuotaError('cancelled', this.closedMessage));

    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    this.active.add(controller);
    // [종료 정책] 제공자를 호출하기 전에 조회를 추적하고 완료 시 취소 핸들과 Promise를 함께 제거한다.
    const reading = Promise.resolve().then(() =>
      this.readQuota({ ...context, signal })).finally(() => {
      this.active.delete(controller);
      this.reads.delete(reading);
    });
    this.reads.add(reading);
    return reading;
  }

  dispose(): Promise<void> {
    // [종료 정책] 모든 활성 조회를 취소하고 정리가 끝날 때까지 같은 종료 Promise를 공유한다.
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
