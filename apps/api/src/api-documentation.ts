import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import sharedOpenApiSchemas from "./generated/shared-openapi-schemas.json" with { type: "json" };
import { getDocumentedRouteSchema, manualOpenApiSchemas } from "./openapi-routes.js";
import { SESSION_COOKIE_NAME } from "./security.js";

export type ApiDocumentationAccess =
  { allowed: true } | { allowed: false; statusCode: 401 | 403; message: string };

export type AuthorizeApiDocumentation = (request: FastifyRequest) => Promise<ApiDocumentationAccess>;

const publicRoutes = new Set([
  "/",
  "/auth/login",
  "/auth/logout",
  "/health",
  "/health/live",
  "/health/ready",
  "/metrics"
]);

export async function registerApiDocumentation(
  app: FastifyInstance,
  authorize: AuthorizeApiDocumentation
): Promise<void> {
  for (const schema of [...Object.values(sharedOpenApiSchemas), ...manualOpenApiSchemas]) {
    app.addSchema(schema);
  }

  await app.register(swagger, {
    refResolver: {
      buildLocalReference: (schema, _baseUri, _fragment, index) =>
        typeof schema.$id === "string" ? schema.$id : `schema-${index}`
    },
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "Outbound Dialer API",
        description:
          "Complete interactive contract for the Outbound Dialer API, including request bodies, path and query parameters, success responses, and error responses for every route.",
        version: "0.1.0"
      },
      servers: [{ url: "/api", description: "Application proxy" }],
      tags: [
        { name: "Auth", description: "Authentication and current-user session" },
        { name: "Agent", description: "Agent Desk, calls, and softphone operations" },
        { name: "Admin", description: "Administrator operations" },
        { name: "System", description: "Service health and monitoring" }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Token returned by POST /auth/login"
          },
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: SESSION_COOKIE_NAME,
            description: "HttpOnly session cookie set by POST /auth/login"
          }
        }
      }
    },
    transform: ({ schema, url, route }) => {
      if (schema?.hide || url.startsWith("/docs")) return { schema, url };
      const documented = getDocumentedRouteSchema(route.method, url);
      return {
        schema: {
          ...documented,
          ...schema,
          tags: schema?.tags ?? [tagForUrl(url)],
          security:
            schema?.security ?? (publicRoutes.has(url) ? [] : [{ bearerAuth: [] }, { sessionCookie: [] }])
        },
        url
      };
    }
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
    indexPrefix: "/api",
    staticCSP: true,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true
    },
    uiHooks: {
      onRequest: async (request, reply) => {
        const access = await authorize(request);
        if (!access.allowed) {
          return sendAccessError(reply, access);
        }
      }
    }
  });
}

function tagForUrl(url: string): "Auth" | "Agent" | "Admin" | "System" {
  if (url.startsWith("/auth/")) return "Auth";
  if (url.startsWith("/agent/")) return "Agent";
  if (url.startsWith("/admin/")) return "Admin";
  return "System";
}

function sendAccessError(reply: FastifyReply, access: Extract<ApiDocumentationAccess, { allowed: false }>) {
  return reply.code(access.statusCode).send({ message: access.message });
}
