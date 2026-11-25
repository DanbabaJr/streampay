import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/address/", "/stream/"],
      disallow: ["/api/"],
    },
    sitemap: "https://streampay.finance/sitemap.xml",
  };
}
