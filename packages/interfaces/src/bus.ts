export type BusCallback<T = any> = (topic: string, message: T) => void | Promise<void>;

export interface IBus {
  publish(topic: string, message: any): Promise<void>;
  subscribe<T = any>(topicPattern: string, callback: BusCallback<T>): () => void;
}
