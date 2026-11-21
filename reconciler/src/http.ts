//! Simple HTTP agent wrapper for making requests with proper error handling.

export interface HttpResponse {
  status: number;
  data: unknown;
  headers: Record<string, string>;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpAgent {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<HttpResponse>;
}

/**
 * Creates an HTTP agent that returns typed responses.
 * Wraps globalThis.fetch for better DX.
 */
export function createHttpAgent(): HttpAgent {
  const request = async (url: string, options: RequestInit): Promise<HttpResponse> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000); // 30s timeout

    try {
      const response = await globalThis.fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          "User-Agent": "streampay-reconciler/1.0.0",
          ...(options.headers || {}),
        },
      });

      clearTimeout(timeoutId);

      // Try to parse JSON body, fallback to text
      let data: unknown;
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          data = await response.json();
        } catch {
          data = await response.text();
        }
      } else {
        data = await response.text();
      }

      return {
        status: response.status,
        data,
        headers: Object.fromEntries(response.headers.entries()),
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new HttpError(408, "Request timeout");
      }
      if (err instanceof HttpError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new HttpError(0, `Network error: ${message}`);
    }
  };

  return {
    async get(url: string, headers = {}): Promise<HttpResponse> {
      return request(url, { method: "GET", headers });
    },
    async post(url: string, body: unknown, headers = {}): Promise<HttpResponse> {
      const stringBody =
        typeof body === "string" ? body : JSON.stringify(body);
      return request(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: stringBody,
      });
    },
  };
}

// Re-export the fetch function for consumers who need more control
export { createHttpAgent as http };
