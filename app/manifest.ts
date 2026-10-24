import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Skill Scanner",
    short_name: "Skill Scanner",
    description:
      "Scan Claude Skills and OpenAI Codex skill files for prompt injection and data exfiltration.",
    start_url: "/",
    display: "standalone",
    background_color: "#fafafa",
    theme_color: "#6d28d9",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
