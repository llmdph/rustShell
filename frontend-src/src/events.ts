type Handler<T> = (payload: T) => void;

export class EventBus<Events extends object> {
  private handlers: Partial<{ [K in keyof Events]: Set<Handler<Events[K]>> }> = {};

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>) {
    const handlers = this.handlers[event] ?? new Set<Handler<Events[K]>>();
    handlers.add(handler);
    this.handlers[event] = handlers;
    return () => {
      handlers.delete(handler);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]) {
    this.handlers[event]?.forEach((handler) => handler(payload));
  }
}
