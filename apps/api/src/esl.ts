import net from "node:net";
import type { AppConfig } from "./config.js";

export async function checkFreeSwitchEsl(config: AppConfig): Promise<string> {
  if (!config.FREESWITCH_ESL_ENABLED) {
    return "disabled by FREESWITCH_ESL_ENABLED=false";
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.FREESWITCH_ESL_HOST,
      port: config.FREESWITCH_ESL_PORT,
      timeout: 2500
    });

    let buffer = "";

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("Content-Type: auth/request")) {
        socket.write(`auth ${config.FREESWITCH_ESL_PASSWORD}\n\n`);
      }
      if (buffer.includes("+OK accepted")) {
        cleanup();
        resolve(`connected to ${config.FREESWITCH_ESL_HOST}:${config.FREESWITCH_ESL_PORT}`);
      }
      if (buffer.includes("-ERR")) {
        cleanup();
        reject(new Error("ESL authentication failed"));
      }
    });

    socket.on("timeout", () => {
      cleanup();
      reject(new Error("ESL connection timed out"));
    });

    socket.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}
