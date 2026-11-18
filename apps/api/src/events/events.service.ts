import { Injectable } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';

export interface SubEvent {
  slug: string;
  event: string;
  data: unknown;
}

@Injectable()
export class EventsService {
  private readonly bus = new Subject<SubEvent>();
  private readonly listeners = new Map<string, number>();

  emit(slug: string, event: string, data: unknown): void {
    this.bus.next({ slug, event, data });
  }

  /** True while at least one dashboard is streaming this endpoint. The hot path skips building events nobody will read. */
  hasListeners(slug: string): boolean {
    return (this.listeners.get(slug) ?? 0) > 0;
  }

  stream(slug: string): Observable<SubEvent> {
    return new Observable<SubEvent>((subscriber) => {
      this.listeners.set(slug, (this.listeners.get(slug) ?? 0) + 1);
      const inner = this.bus.subscribe((e) => {
        if (e.slug === slug) subscriber.next(e);
      });
      return () => {
        inner.unsubscribe();
        const n = (this.listeners.get(slug) ?? 1) - 1;
        if (n <= 0) this.listeners.delete(slug);
        else this.listeners.set(slug, n);
      };
    });
  }
}
