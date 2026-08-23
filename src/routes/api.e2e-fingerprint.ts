import { createFileRoute } from "@tanstack/react-router";

import {
  crearFingerprintServidorFiscalE2E,
  entornoMockFiscalDelProceso,
} from "@/lib/fiscal/mock-scenario.server";

export const Route = createFileRoute("/api/e2e-fingerprint")({
  server: {
    handlers: {
      GET: async () => {
        const fingerprint = crearFingerprintServidorFiscalE2E(entornoMockFiscalDelProceso());
        const headers = {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        if (!fingerprint) return new Response("Not Found", { status: 404, headers });
        return Response.json(fingerprint, { headers });
      },
    },
  },
});
