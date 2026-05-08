// BullMQ Queue producer client. Constructed in the composition
// root; routes receive narrow `enqueue*` functions, not the Queue.

import { Queue } from "bullmq";
import IORedis from "ioredis";
import { QUEUE, type QueueName } from "@aonex/types";

export interface QueueClientDeps {
  redisUrl: string;
}

export class QueueClient {
  private readonly connection: IORedis;
  private readonly queues = new Map<QueueName, Queue>();

  constructor(deps: QueueClientDeps) {
    this.connection = new IORedis(deps.redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true
    });
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    await this.connection.quit();
  }
}

export { QUEUE };
