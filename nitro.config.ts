import type { NitroConfig } from "nitro/types";

export default {
  vercel: {
    functions: { runtime: "nodejs24.x" },
  },
} satisfies NitroConfig;
