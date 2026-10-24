import { generateOpenApiSpec } from "@/lib/openapi";

export async function GET(): Promise<Response> {
  const spec = generateOpenApiSpec();
  return new Response(JSON.stringify(spec, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
