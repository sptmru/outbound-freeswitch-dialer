import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type pg from "pg";
import type { AppConfig } from "./config.js";
import { requireUser } from "./auth/routes.js";

export type LiveEvent = {
  type: "refresh";
  source: string;
  occurredAt: string;
};

export type LiveEventHub = ReturnType<typeof createLiveEventHub>;

export function createLiveEventHub() {
  const subscribers = new Set<(event: LiveEvent) => void>();
  return {
    publish(event: LiveEvent) {
      for (const subscriber of subscribers) {
        subscriber(event);
      }
    },
    subscribe(subscriber: (event: LiveEvent) => void) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    }
  };
}

export function registerLiveEventRoutes(
  app: FastifyInstance,
  config: AppConfig,
  pool: pg.Pool,
  hub: LiveEventHub
): void {
  app.get("/agent/events", async (request, reply) => {
    const user = await requireUser(request, config, pool);
    if (!user) {
      return reply.code(401).send({ message: "Unauthorized" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write("retry: 3000\n\n");
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ occurredAt: new Date().toISOString() })}\n\n`);

    const unsubscribe = hub.subscribe((event) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: refresh\ndata: ${JSON.stringify(event)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
      }
    }, 15_000);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("error", cleanup);
    return reply;
  });
}

export function startDatabaseLiveEventListener(pool: pg.Pool, hub: LiveEventHub, logger: FastifyBaseLogger) {
  let client: pg.PoolClient | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 2_000);
    reconnectTimer.unref();
  };

  const connect = async () => {
    if (stopped || client) return;
    try {
      const nextClient = await pool.connect();
      client = nextClient;
      nextClient.on("notification", (message) => {
        hub.publish({
          type: "refresh",
          source: message.payload || "database",
          occurredAt: new Date().toISOString()
        });
      });
      nextClient.on("error", (error) => {
        logger.error(error, "PostgreSQL live-event listener disconnected");
        if (client === nextClient) client = null;
        nextClient.release(true);
        scheduleReconnect();
      });
      await nextClient.query("listen outbound_dialer_changes");
      logger.info("PostgreSQL live-event listener subscribed");
    } catch (error) {
      logger.error(error, "PostgreSQL live-event listener failed to subscribe");
      if (client) {
        client.release(true);
        client = null;
      }
      scheduleReconnect();
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (client) {
      void client.query("unlisten outbound_dialer_changes").catch(() => undefined);
      client.release();
      client = null;
    }
  };
}
