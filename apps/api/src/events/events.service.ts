import { Injectable } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export interface SubEvent {
  slug: string;
  event: string;
  data: unknown;
}

@Injectable()
export class EventsService {
  private readonly bus = new Subject<SubEvent>();

  emit(slug: string, event: string, data: unknown): void {
    this.bus.next({ slug, event, data });
  }

  stream(slug: string): Observable<SubEvent> {
    return this.bus.pipe(filter((e) => e.slug === slug));
  }
}
